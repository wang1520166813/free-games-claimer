import { firefox } from 'playwright-firefox'; // stealth plugin needs no outdated playwright-extra
import { authenticator } from 'otplib';
import chalk from 'chalk';
import path from 'path';
import { existsSync, writeFileSync, appendFileSync } from 'fs';
import { resolve, jsonDb, datetime, stealth, filenamify, prompt, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

const screenshot = (...a) => resolve(cfg.dir.screenshots, 'epic-games', ...a);

const URL_CLAIM = 'https://store.epicgames.com/en-US/free-games';
const URL_LOGIN = 'https://www.epicgames.com/id/login?lang=en-US&noHostRedirect=true&redirectUrl=' + URL_CLAIM;

console.log(datetime(), 'started checking epic-games');

const db = await jsonDb('epic-games.json', {});

if (cfg.time) console.time('startup');

const browserPrefs = path.join(cfg.dir.browser, 'prefs.js');
if (existsSync(browserPrefs)) {
 console.log('Adding webgl.disabled to', browserPrefs);
 appendFileSync(browserPrefs, 'user_pref("webgl.disabled", true);'); // apparently Firefox removes duplicates (and sorts), so no problem appending every time
} else {
 console.log(browserPrefs, 'does not exist yet, will patch it on next run. Restart the script if you get a captcha.');
}

// Enhanced browser configuration to avoid detection
const context = await firefox.launchPersistentContext(cfg.dir.browser, {
 headless: cfg.headless,
 viewport: { width: cfg.width, height: cfg.height },
 // More realistic User-Agent matching Firefox on Windows
 userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
 locale: 'en-US',
 recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined,
 recordHar: cfg.record ? { path: `data/record/eg-${filenamify(datetime())}.har` } : undefined,
 handleSIGINT: false,
 args: [
 '-kiosk', // Kiosk mode can help with some fingerprinting
 ],
});

handleSIGINT(context);

await stealth(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage();
await page.setViewportSize({ width: cfg.width, height: cfg.height });

// Enhanced debug info
if (cfg.debug) {
 const debugInfo = await page.evaluate(() => [
  window.screen.width, window.screen.height,
  navigator.userAgent,
  navigator.platform,
  navigator.vendor
 ]);
 console.debug('Browser debug info:', debugInfo);
}

if (cfg.debug_network) {
 const filter = r => r.url().includes('store.epicgames.com');
 page.on('request', request => filter(request) && console.log('>>', request.method(), request.url()));
 page.on('response', response => filter(response) && console.log('<<', response.status(), response.url()));
}

const notify_games = [];
let user;

// Helper function to save screenshots with timestamps
async function saveScreenshot(page, prefix = 'debug') {
 try {
  const timestamp = filenamify(datetime());
  const p = screenshot(`${prefix}_${timestamp}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`Screenshot saved: ${p}`);
  return p;
 } catch (e) {
  console.error('Failed to save screenshot:', e);
  return null;
 }
}

// Helper function to parse and inject cookies from EPIC_COOKIE environment variable
async function tryCookieLogin() {
 if (!process.env.EPIC_COOKIE) {
  return false;
 }

 console.log('🔑 Detected EPIC_COOKIE, attempting cookie-based login...');

 try {
  // Parse the cookie string into Playwright cookie format
  const cookieString = process.env.EPIC_COOKIE.trim();
  const cookies = cookieString.split('; ').map(cookieStr => {
   const [name, value] = cookieStr.split('=');
   return {
    name: name,
    value: value,
    domain: '.epicgames.com',
    url: 'https://www.epicgames.com'
   };
  });

  // Inject cookies
  await context.addCookies(cookies);
  console.log(`✅ Injected ${cookies.length} cookies`);

  // Navigate to store to verify login
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait a bit for page to fully load
  await page.waitForTimeout(3000);

  // Check if logged in by looking for user avatar or isloggedin attribute
  const isLoggedIn = await page.locator('egs-navigation').getAttribute('isloggedin');
  
  if (isLoggedIn === 'true') {
   user = await page.locator('egs-navigation').getAttribute('displayname');
   console.log(`✅ Cookie login successful! Signed in as: ${user}`);
   await saveScreenshot(page, 'logged_in_via_cookie');
   return true;
  } else {
   console.warn('⚠️ Cookie login failed: Page shows not logged in. Cookies may be expired or invalid.');
   await saveScreenshot(page, 'cookie_login_failed');
   return false;
  }
 } catch (e) {
  console.warn('⚠️ Cookie login error:', e.message);
  await saveScreenshot(page, 'cookie_login_error');
  return false;
 }
}

try {
 await context.addCookies([
  { name: 'OptanonAlertBoxClosed', value: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), domain: '.epicgames.com', path: '/' },
  { name: 'HasAcceptedAgeGates', value: 'USK:9007199254740991,general:18,EPIC SUGGESTED RATING:18', domain: 'store.epicgames.com', path: '/' },
 ]);

 console.log('Navigating to Epic Games store...');
 await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded', timeout: 60000 });

 if (cfg.time) console.timeEnd('startup');
 if (cfg.time) console.time('login');

 // Check if already logged in
 let isLoggedIn = await page.locator('egs-navigation').getAttribute('isloggedin');
 
 // Try cookie login first if EPIC_COOKIE is set
 if (!isLoggedIn && process.env.EPIC_COOKIE) {
  const cookieLoginSuccess = await tryCookieLogin();
  if (cookieLoginSuccess) {
   isLoggedIn = 'true';
  }
 }

 if (isLoggedIn != 'true') {
  console.error('Not signed in anymore. Starting login process...');
  await saveScreenshot(page, 'before_login');
  
  if (cfg.novnc_port) console.info(`Open http://localhost:${cfg.novnc_port} to login inside the docker container.`);
  if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout);
  console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
  
  await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Save screenshot of login page
  await saveScreenshot(page, 'login_page');

  if (cfg.eg_email && cfg.eg_password) console.info('Using email and password from environment.');
  else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');

  const notifyBrowserLogin = async () => {
   console.log('Waiting for you to login in the browser.');
   await notify('epic-games: no longer signed in and not enough options set for automatic login.');
   if (cfg.headless) {
    console.log('Run `SHOW=1 node epic-games` to login in the opened browser.');
    await saveScreenshot(page, 'browser_login_required');
    await context.close();
    process.exit(1);
   }
  };

  const email = cfg.eg_email || await prompt({ message: 'Enter email' });
  
  if (!email) {
   await notifyBrowserLogin();
  } else {
   // Monitor for captcha
   page.waitForSelector('.h_captcha_challenge iframe').then(async () => {
    console.error('Got a captcha during login! This may be due to suspicious activity or IP reputation.');
    await saveScreenshot(page, 'captcha_detected');
    await notify('epic-games: got captcha during login. Please check.');
   }).catch(_ => { });

   // Monitor for incorrect captcha response
   page.waitForSelector('p:has-text("Incorrect response.")').then(async () => {
    console.error('Incorrect response for captcha!');
    await saveScreenshot(page, 'captcha_error');
   }).catch(_ => { });

   await page.fill('#email', email);
   
   const password = email && (cfg.eg_password || await prompt({ type: 'password', message: 'Enter password' }));
   
   if (!password) {
    await notifyBrowserLogin();
   } else {
    console.log('Submitting login credentials...');
    await page.fill('#password', password);
    await page.click('button[type="submit"]');
    
    // Monitor for login errors
    const error = page.locator('#form-error-message');
    error.waitFor().then(async () => {
     const errorMsg = await error.innerText();
     console.error('Login error:', errorMsg);
     await saveScreenshot(page, 'login_error');
     console.log('Please login in the browser!');
    }).catch(_ => { });
   }

   // Handle MFA
   page.waitForURL('**/id/login/mfa**').then(async () => {
    console.log('MFA detected. Enter the security code to continue...');
    const otp = cfg.eg_otpkey && authenticator.generate(cfg.eg_otpkey) || await prompt({ type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!' });
    await page.locator('input[name="code-input-0"]').pressSequentially(otp.toString());
    await page.click('button[type="submit"]');
   }).catch(_ => { });
  }

  // Wait for successful login with increased timeout and retries
  console.log('Waiting for successful login...');
  let loginAttempts = 0;
  const maxLoginAttempts = 3;
  
  while (loginAttempts < maxLoginAttempts) {
   try {
    await page.waitForURL(URL_CLAIM, { timeout: 180000 }); // 3 minutes timeout
    break; // Successfully navigated
   } catch (e) {
    loginAttempts++;
    console.error(`Login attempt ${loginAttempts} failed. Retrying...`);
    await saveScreenshot(page, `login_timeout_attempt_${loginAttempts}`);
    
    if (loginAttempts >= maxLoginAttempts) {
     console.error('Max login attempts reached. Please check credentials.');
     await saveScreenshot(page, 'login_final_failure');
     throw new Error('Login failed after multiple attempts');
    }
   }
  }
  
  if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
 }

 if (!user) {
  user = await page.locator('egs-navigation').getAttribute('displayname');
 }
 console.log(`Signed in as ${user}`);
 await saveScreenshot(page, 'logged_in_success');
 
 db.data[user] ||= {};
 if (cfg.time) console.timeEnd('login');
 if (cfg.time) console.time('claim all games');

 // Detect free games
 console.log('Checking for free games...');
 const game_loc = page.locator('a:has(span:text-is("Free Now"))');
 await game_loc.last().waitFor().catch(async _ => {
  console.error('No free games currently available or timeout waiting for games.');
  console.error('This could be due to: 1) No free games this week, 2) Region restrictions, 3) Page loading issues');
  await saveScreenshot(page, 'no_free_games');
 });

 const urlSlugs = await Promise.all((await game_loc.elementHandles()).map(a => a.getAttribute('href')));
 const urls = urlSlugs.map(s => 'https://store.epicgames.com' + s);
 console.log('Free games:', urls);

 for (const url of urls) {
  if (cfg.time) console.time('claim game');
  console.log(`Processing game: ${url}`);
  
  await page.goto(url);
  const purchaseBtn = page.locator('button[data-testid="purchase-cta-button"] >> :has-text("e"), :has-text("i")').first();
  await purchaseBtn.waitFor();
  const btnText = (await purchaseBtn.innerText()).toLowerCase();

  // Age verification
  if (await page.locator('button:has-text("Continue")').count() > 0) {
   console.log('Mature content age verification required');
   if (await page.locator('[data-testid="AgeSelect"]').count()) {
    console.error('Age gate detected - this should not happen with proper cookies');
    await saveScreenshot(page, 'age_gate');
    await page.locator('#month_toggle').click();
    await page.locator('#month_menu li:has-text("01")').click();
    await page.locator('#day_toggle').click();
    await page.locator('#day_menu li:has-text("01")').click();
    await page.locator('#year_toggle').click();
    await page.locator('#year_menu li:has-text("1987")').click();
   }
   await page.click('button:has-text("Continue")', { delay: 111 });
   await page.waitForTimeout(2000);
  }

  let title;
  let bundle_includes;
  if (await page.locator('span:text-is("About Bundle")').count()) {
   title = (await page.locator('span:has-text("Buy"):left-of([data-testid="purchase-cta-button"])').first().innerText()).replace('Buy ', '');
   try {
    bundle_includes = await Promise.all((await page.locator('.product-card-top-row h5').all()).map(b => b.innerText()));
   } catch (e) {
    console.error('Failed to get "Bundle Includes":', e);
   }
  } else {
   title = await page.locator('h1').first().innerText();
  }
  
  const game_id = page.url().split('/').pop();
  const existedInDb = db.data[user][game_id];
  db.data[user][game_id] ||= { title, time: datetime(), url: page.url() };
  console.log('Current free game:', chalk.blue(title));
  if (bundle_includes) console.log('This bundle includes:', bundle_includes);
  
  const notify_game = { title, url, status: 'failed' };
  notify_games.push(notify_game);

  if (btnText == 'in library') {
   console.log('Already in library!');
   if (!existedInDb) await notify(`Game already in library: ${url}`);
   notify_game.status = 'existed';
   db.data[user][game_id].status ||= 'existed';
   if (db.data[user][game_id].status.startsWith('failed')) db.data[user][game_id].status = 'manual';
  } else if (btnText == 'requires base game') {
   console.log('Requires base game!');
   notify_game.status = 'requires base game';
   db.data[user][game_id].status ||= 'failed:requires-base-game';
   const baseUrl = 'https://store.epicgames.com' + await page.locator('a:has-text("Overview")').getAttribute('href');
   console.log('Base game:', baseUrl);
   urls.push(baseUrl);
   urls.push(url);
  } else {
   console.log('Claiming game...');
   await purchaseBtn.click({ delay: 11 });

   page.click('button:has-text("Continue")').catch(_ => { });
   page.click('button:has-text("Yes, buy now")').catch(_ => { });

   page.locator(':has-text("end user license agreement")').waitFor().then(async () => {
    console.log('Accepting End User License Agreement...');
    await page.locator('input#agree').check();
    await page.locator('button:has-text("Accept")').click();
   }).catch(_ => { });

   await page.waitForSelector('#webPurchaseContainer iframe');
   const iframe = page.frameLocator('#webPurchaseContainer iframe');
   
   if (await iframe.locator(':has-text("unavailable in your region")').count() > 0) {
    console.error('Product unavailable in your region!');
    db.data[user][game_id].status = notify_game.status = 'unavailable-in-region';
    if (cfg.time) console.timeEnd('claim game');
    continue;
   }

   iframe.locator('.payment-pin-code').waitFor().then(async () => {
    if (!cfg.eg_parentalpin) {
     console.error('EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
     notify('epic-games: EG_PARENTALPIN not set. Need to enter Parental Control PIN manually.');
    }
    await iframe.locator('input.payment-pin-code__input').first().pressSequentially(cfg.eg_parentalpin);
    await iframe.locator('button:has-text("Continue")').click({ delay: 11 });
   }).catch(_ => { });

   if (cfg.debug) await page.pause();
   if (cfg.dryrun) {
    console.log('DRYRUN=1 -> Skip order!');
    notify_game.status = 'skipped';
    if (cfg.time) console.timeEnd('claim game');
    continue;
   }

   await iframe.locator('button:has-text("Place Order"):not(:has(.payment-loading--loading))').click({ delay: 11 });

   const btnAgree = iframe.locator('button:has-text("I Accept")');
   btnAgree.waitFor().then(() => btnAgree.click()).catch(_ => { });

   try {
    const captcha = iframe.locator('#h_captcha_challenge_checkout_free_prod iframe');
    captcha.waitFor().then(async () => {
     console.error('Captcha challenge detected!');
     await saveScreenshot(page, 'captcha_challenge');
     await notify(`epic-games: captcha challenge for ${title}. Game link: ${url}`);
    }).catch(_ => { });
    
    iframe.locator('.payment__errors:has-text("Failed to challenge captcha, please try again later.")').waitFor().then(async () => {
     console.error('Failed to challenge captcha!');
     await notify('epic-games: failed to challenge captcha. Please check.');
    }).catch(_ => { });
    
    await page.locator('text=Thanks for your order!').waitFor({ state: 'attached' });
    db.data[user][game_id].status = 'claimed';
    db.data[user][game_id].time = datetime();
    console.log('Claimed successfully!');
   } catch (e) {
    console.log(e);
    console.error('Failed to claim! Check for captcha or network issues.');
    const p = screenshot('failed', `${game_id}_${filenamify(datetime())}.png`);
    await page.screenshot({ path: p, fullPage: true });
    db.data[user][game_id].status = 'failed';
   }
   
   notify_game.status = db.data[user][game_id].status;

   const p = screenshot(`${game_id}.png`);
   if (!existsSync(p)) await page.screenshot({ path: p, fullPage: false });
  }
  
  if (cfg.time) console.timeEnd('claim game');
 }
 
 if (cfg.time) console.timeEnd('claim all games');
} catch (error) {
 process.exitCode ||= 1;
 console.error('--- Exception:');
 console.error(error);
 await saveScreenshot(page, 'final_error');
 if (error.message && process.exitCode != 130) notify(`epic-games failed: ${error.message.split('\n')[0]}`);
} finally {
 await db.write();
 if (notify_games.filter(g => g.status == 'claimed' || g.status == 'failed').length) {
  notify(`epic-games (${user}):<br>${html_game_list(notify_games)}`);
 }
}

if (cfg.debug) writeFileSync(path.resolve(cfg.dir.browser, 'cookies.json'), JSON.stringify(await context.cookies()));
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();