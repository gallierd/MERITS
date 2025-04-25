import "dotenv/config";
import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import puppeteer from "puppeteer-extra";
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

// Konfigurasi Selector Baru
const MERIT_URL = "https://eth.blockscout.com/account/merits";
const CONNECT_SELECTOR = "#__next > div > div.css-kk2gsb > div.css-peumoz > main > div.css-b63mbj > div.css-11jyqk4 > div:nth-child(1) > div.css-xwx4zh > button";
const CLAIM_SELECTOR = "#__next > div > div.css-kk2gsb > div.css-peumoz > main > div.css-b63mbj > div.css-11jyqk4 > div:nth-child(1) > div.css-xwx4zh > div.css-ae3amp";
const INTERVAL_13H = 46800000;

// Inisialisasi UI
const screen = blessed.screen({
  smartCSR: true,
  title: "Merit Claim Bot v2",
  fullUnicode: true,
  mouse: true
});

// Komponen UI yang Diperbarui
const components = {
  header: blessed.box({
    top: 0,
    left: "center",
    width: "100%",
    height: '10%',
    tags: true,
    style: { fg: "cyan" }
  }),

  status: blessed.box({
    top: '10%',
    width: "100%",
    height: '10%',
    tags: true,
    border: { type: "line", fg: "cyan" },
    label: ' Status ',
    style: { border: { fg: "cyan" } }
  }),

  wallets: blessed.list({
    top: '20%',
    left: 0,
    width: "50%",
    height: '60%',
    border: { type: "line", fg: "cyan" },
    label: ' Wallets ',
    keys: true,
    style: {
      border: { fg: "cyan" },
      selected: { bg: "blue", fg: "black" }
    }
  }),

  logs: blessed.log({
    top: '20%',
    left: "50%",
    width: "50%",
    height: '60%',
    border: { type: "line", fg: "cyan" },
    label: ' Logs ',
    scrollable: true
  }),

  menu: blessed.list({
    bottom: 0,
    width: "100%",
    height: '10%',
    border: { type: "line", fg: "cyan" },
    label: ' Actions ',
    items: ['Start All', 'Stop All', 'Refresh', 'Exit']
  })
};

// State Management
let wallets = [];
let claims = new Map();
let selected = { index: 0 };
const loadingSpinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;

// Fungsi Utilitas
function getShortAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'N/A';
}

function addLog(message, type = 'info') {
  const colors = { info: 'white', success: 'green', error: 'red', warning: 'yellow' };
  const timestamp = new Date().toLocaleTimeString();
  components.logs.add(`{${colors[type]}-fg}[${timestamp}] ${message}{/}`);
  screen.render();
}

function updateStatus() {
  const activeClaims = [...claims.values()].filter(c => c.active).length;
  components.status.setContent(
    `Active: ${activeClaims}/${wallets.length} | ` +
    `Next Update: ${loadingSpinner[spinnerIndex]} | ` +
    `Selected: #${selected.index + 1}`
  );
  spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
}

// Implementasi Core
async function loadWallets() {
  try {
    const keys = fs.readFileSync('pk.txt', 'utf-8')
      .split('\n')
      .map(k => k.trim())
      .filter(k => k.length === 64 || k.startsWith('0x'));
    
    const proxies = fs.existsSync('proxy.txt') ? 
      fs.readFileSync('proxy.txt', 'utf-8').split('\n') : [];

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
    addLog(`Load error: ${error.message}`, 'error');
    process.exit(1);
  }
}

function updateWalletDisplay() {
  const items = wallets.map((w, i) => [
    i === selected.index ? chalk.cyan('→') : ' ',
    chalk.dim(`#${(i + 1).toString().padStart(2, '0')}`),
    getShortAddress(w.address),
    chalk.blue(`${w.balance} ETH`),
    chalk.yellow(w.lastClaim),
    chalk.green(w.nextClaim),
    claims.get(i)?.active ? chalk.yellow('Claiming') : chalk.green('Idle')
  ].join('  '));

  components.wallets.setItems(items);
  screen.render();
}

async function executeClaim(wallet) {
  let browser;
  try {
    claims.get(wallet.index).active = true;
    addLog(`Wallet #${wallet.index + 1}: Starting process...`, 'info');

    // Browser Configuration
    const launchOptions = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    };

    if (wallet.proxy) {
      launchOptions.args.push(`--proxy-server=${wallet.proxy}`);
    }

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Ethereum Provider Simulation
    await page.evaluateOnNewDocument((privateKey, address) => {
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts') return [address];
          if (method === 'eth_accounts') return [address];
          if (method === 'personal_sign') {
            const signer = new ethers.Wallet(privateKey);
            return signer.signMessage(ethers.getBytes(params[0]));
          }
        }
      };
    }, wallet.key, wallet.address);

    // Navigasi dan Interaksi
    await page.goto(MERIT_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Connect Wallet
    await page.waitForSelector(CONNECT_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(CONNECT_SELECTOR);
    await page.waitForTimeout(5000);

    // Claim Merits
    await page.waitForSelector(CLAIM_SELECTOR, { visible: true, timeout: 30000 });
    await page.click(CLAIM_SELECTOR);
    await page.waitForTimeout(3000);

    // Update Status
    wallet.lastClaim = new Date().toLocaleString();
    wallet.nextClaim = new Date(Date.now() + INTERVAL_13H).toLocaleString();
    addLog(`Wallet #${wallet.index + 1}: Claim successful!`, 'success');

  } catch (error) {
    addLog(`Wallet #${wallet.index + 1}: ${error.message}`, 'error');
  } finally {
    if (browser) await browser.close();
    claims.get(wallet.index).active = false;
    updateWalletDisplay();
  }
}

function manageClaims(wallet) {
  if (claims.has(wallet.index)) {
    clearTimeout(claims.get(wallet.index).timer);
  }

  const timer = setTimeout(async () => {
    await executeClaim(wallet);
    manageClaims(wallet); // Reschedule
  }, wallet.nextClaim === 'N/A' ? 0 : INTERVAL_13H);

  claims.set(wallet.index, { timer, active: false });
}

// Event Handlers
components.wallets.key(['up', 'down'], (_, key) => {
  selected.index = Math.max(0, Math.min(wallets.length - 1, 
    key.name === 'up' ? selected.index - 1 : selected.index + 1));
  updateWalletDisplay();
});

components.menu.on('select', item => {
  switch (item.getText()) {
    case 'Start All':
      wallets.forEach(w => manageClaims(w));
      addLog('Started all claim processes', 'success');
      break;

    case 'Stop All':
      claims.forEach(c => clearTimeout(c.timer));
      addLog('Stopped all processes', 'warning');
      break;

    case 'Refresh':
      loadWallets().then(updateWalletDisplay);
      break;

    case 'Exit':
      process.exit(0);
  }
});

screen.key(['q', 'C-c'], () => process.exit(0));

// Inisialisasi
(async () => {
  figlet.text('Merit Bot', (err, data) => {
    components.header.setContent(chalk.cyan(data));
    screen.render();
  });

  await loadWallets();
  updateWalletDisplay();
  setInterval(updateStatus, 1000);
  
  // Initial claims setup
  wallets.forEach(w => manageClaims(w));
})();