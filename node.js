import "dotenv/config";
import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import puppeteer from "puppeteer-extra";
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Inisialisasi Puppeteer
puppeteer.use(StealthPlugin());

// Konfigurasi
const MERIT_URL = "https://eth.blockscout.com/account/merits";
const CONNECT_SELECTOR = "#__next > div > div.css-kk2gsb > div.css-peumoz > main > div.css-b63mbj > div.css-11jyqk4 > div:nth-child(1) > div.css-xwx4zh > button";
const CLAIM_SELECTOR = "#__next > div > div.css-kk2gsb > div.css-peumoz > main > div.css-b63mbj > div.css-11jyqk4 > div:nth-child(1) > div.css-xwx4zh > div.css-ae3amp";
const INTERVAL_13H = 46800000; // 13 jam dalam milidetik

// Inisialisasi UI
const screen = blessed.screen({
  smartCSR: true,
  title: "Merit Circle Auto Claimer Pro",
  fullUnicode: true,
  dockBorders: true,
  warnings: false
});

// Komponen UI yang Diperbarui
const components = {
  header: blessed.box({
    top: 0,
    left: "center",
    width: "100%",
    height: 3,
    tags: true,
    style: { fg: "cyan" }
  }),

  status: blessed.box({
    top: 3,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line", fg: "cyan" },
    label: ' {cyan-fg}Status{/} ',
    style: { border: { fg: "cyan" } }
  }),

  wallets: blessed.list({
    top: 6,
    left: 0,
    width: "50%",
    height: "70%",
    border: { type: "line", fg: "cyan" },
    label: ' {cyan-fg}Wallets{/} ',
    keys: true,
    mouse: true,
    style: {
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "black" }
    }
  }),

  logs: blessed.log({
    top: 6,
    left: "50%",
    width: "50%",
    height: "70%",
    border: { type: "line", fg: "cyan" },
    label: ' {cyan-fg}Logs{/} ',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
      ch: ' ',
      inverse: true,
      style: { bg: "cyan" }
    }
  }),

  menu: blessed.list({
    bottom: 0,
    width: "100%",
    height: 3,
    border: { type: "line", fg: "cyan" },
    label: ' {cyan-fg}Actions{/} ',
    items: ['Start All', 'Stop All', 'Refresh', 'Exit'],
    keys: true,
    style: {
      selected: { bg: "magenta", fg: "black" }
    }
  })
};

// Inisialisasi Komponen
Object.values(components).forEach(c => screen.append(c));

// State Management
let wallets = [];
let claims = new Map();
let selectedIndex = 0;
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;

// Fungsi Utilitas
const getShortAddress = (address) => 
  address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'N/A';

const addLog = (message, type = 'info') => {
  const colorMap = {
    info: 'white',
    success: 'green',
    error: 'red',
    warning: 'yellow'
  };
  
  const timestamp = new Date().toLocaleTimeString();
  const logMessage = `{${colorMap[type]}-fg}[${timestamp}] ${message}{/}`;
  
  components.logs.add(logMessage);
  components.logs.setScrollPerc(100);
  screen.render();
};

const updateStatus = () => {
  const active = Array.from(claims.values()).filter(c => c.active).length;
  components.status.setContent(
    ` Active: {green-fg}${active}{/}/{green-fg}${wallets.length}{/} ` +
    ` | Next Refresh: {cyan-fg}${spinnerFrames[spinnerIndex]}{/} ` +
    ` | Selected: {yellow-fg}#${selectedIndex + 1}{/} `
  );
  spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
};

// Fungsi Utama
const loadWallets = async () => {
  try {
    const keys = fs.readFileSync('pk.txt', 'utf-8')
      .split('\n')
      .map(k => k.trim())
      .filter(k => k.length === 64 || k.startsWith('0x'));
    
    const proxies = fs.existsSync('proxy.txt') 
      ? fs.readFileSync('proxy.txt', 'utf-8').split('\n') 
      : [];

    wallets = keys.map((key, i) => ({
      index: i,
      key: key.startsWith('0x') ? key : `0x${key}`,
      address: new ethers.Wallet(key).address,
      proxy: proxies[i % proxies.length],
      balance: '0.00',
      lastClaim: 'Never',
      nextClaim: 'N/A'
    }));

    addLog(`Loaded ${keys.length} wallets`, 'success');
  } catch (error) {
    addLog(`Failed to load wallets: ${error.message}`, 'error');
    process.exit(1);
  }
};

const updateWalletList = () => {
  const items = wallets.map((w, i) => [
    i === selectedIndex ? '{cyan-fg}→{/}' : ' ',
    `{gray-fg}#${(i + 1).toString().padStart(2, '0')}{/}`,
    getShortAddress(w.address),
    `{blue-fg}${w.balance} ETH{/}`,
    `{yellow-fg}${w.lastClaim}{/}`,
    `{green-fg}${w.nextClaim}{/}`,
    claims.get(i)?.active ? '{yellow-fg}Claiming{/}' : '{green-fg}Idle{/}'
  ].join(' '));

  components.wallets.setItems(items);
  screen.render();
};

const executeClaim = async (wallet) => {
  let browser;
  try {
    claims.get(wallet.index).active = true;
    addLog(`Wallet #${wallet.index + 1}: Starting claim process...`, 'info');

    // Konfigurasi Browser
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    };

    if (wallet.proxy) {
      launchOptions.args.push(`--proxy-server=${wallet.proxy}`);
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    // Set viewport dan user agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // Inject Ethereum provider
    await page.evaluateOnNewDocument((privateKey, address) => {
      window.ethereum = {
        isMetaMask: true,
        _state: { isConnected: true },
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts') return [address];
          if (method === 'eth_accounts') return [address];
          if (method === 'personal_sign') {
            const signer = new ethers.Wallet(privateKey);
            return signer.signMessage(ethers.getBytes(params[0]));
          }
          return null;
        }
      };
    }, wallet.key, wallet.address);

    // Navigasi ke halaman
    await page.goto(MERIT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Connect Wallet
    await page.waitForSelector(CONNECT_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(CONNECT_SELECTOR);
    await page.waitForTimeout(5000);

    // Claim Merits
    await page.waitForSelector(CLAIM_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(CLAIM_SELECTOR);
    await page.waitForTimeout(3000);

    // Update status
    wallet.lastClaim = new Date().toLocaleString();
    wallet.nextClaim = new Date(Date.now() + INTERVAL_13H).toLocaleString();
    addLog(`Wallet #${wallet.index + 1}: Claim successful!`, 'success');

  } catch (error) {
    addLog(`Wallet #${wallet.index + 1}: ${error.message}`, 'error');
  } finally {
    if (browser) await browser.close();
    claims.get(wallet.index).active = false;
    updateWalletList();
  }
};

const scheduleClaim = (wallet) => {
  if (claims.has(wallet.index)) {
    clearTimeout(claims.get(wallet.index).timer);
  }

  const timer = setTimeout(async () => {
    await executeClaim(wallet);
    scheduleClaim(wallet);
  }, wallet.nextClaim === 'N/A' ? 0 : INTERVAL_13H);

  claims.set(wallet.index, { timer, active: false });
};

// Event Handlers
components.wallets.key(['up', 'down'], (_, key) => {
  selectedIndex = Math.max(0, Math.min(wallets.length - 1, 
    key.name === 'up' ? selectedIndex - 1 : selectedIndex + 1));
  updateWalletList();
});

components.menu.on('select', item => {
  switch (item.getText()) {
    case 'Start All':
      wallets.forEach(w => scheduleClaim(w));
      addLog('Started all claim processes', 'success');
      break;

    case 'Stop All':
      claims.forEach(c => clearTimeout(c.timer));
      addLog('Stopped all processes', 'warning');
      break;

    case 'Refresh':
      loadWallets().then(updateWalletList);
      break;

    case 'Exit':
      process.exit(0);
  }
});

screen.key(['q', 'C-c'], () => process.exit(0));

// Inisialisasi Aplikasi
(async () => {
  figlet.text('Merit Bot', (err, data) => {
    components.header.setContent(`{cyan-fg}${data}{/}`);
    screen.render();
  });

  await loadWallets();
  updateWalletList();
  setInterval(updateStatus, 150);

  // Mulai proses claim awal
  wallets.forEach(w => scheduleClaim(w));
})();