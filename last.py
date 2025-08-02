import time
import asyncio
import logging
import re
import os # Import the 'os' module
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, WebDriverException

# --- BOT AND API CONFIGURATION (SECURITY FIX!) ---
# NEVER hardcode your token. Use environment variables.
# Before running, set it in your terminal:
# For Windows: set TELEGRAM_BOT_TOKEN="YOUR_NEW_TOKEN"
# For Linux/macOS: export TELEGRAM_BOT_TOKEN="YOUR_NEW_TOKEN"
TELEGRAM_BOT_TOKEN = "8064243654:AAGjbAmpzh2zgzYRaKHfEdYh0N-ZeL2JgTs"

# A dictionary mapping user-friendly country names to their URLs
COUNTRY_URLS = {
    "india": "https://onlineproxy.io/country/india",
    "united-states": "https://onlineproxy.io/country/united-states",
    "china": "https://onlineproxy.io/country/china",
    "germany": "https://onlineproxy.io/country/germany",
    "canada": "https://onlineproxy.io/country/canada",
    "france": "https://onlineproxy.io/country/france",
    "south-africa": "https://onlineproxy.io/country/south-africa",
    "russia": "https://onlineproxy.io/country/russia",
}

# --- HELPER FUNCTION FOR MARKDOWNV2 ---
def escape_markdown_v2(text: str) -> str:
    """Escapes special characters for Telegram's MarkdownV2 parser."""
    escape_chars = r'_*[]()~`>#+-=|{}.!'
    return re.sub(f'([{re.escape(escape_chars)}])', r'\\\1', text)

# --- SELENIUM WEB SCRAPER ---
def get_proxy_details(url: str) -> list:
    """
    This function scrapes proxy details and returns a list of dictionaries,
    with each dictionary containing the components of a single proxy.
    """
    print(f"[SCRAPER] Starting to scrape {url}...")
    options = webdriver.ChromeOptions()
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--log-level=3')
    options.add_experimental_option('excludeSwitches', ['enable-logging'])
    
    scraped_proxies_data = [] # Will store a list of dictionaries

    try:
        driver = webdriver.Chrome(options=options)
        driver.set_window_size(1920, 1080)
        driver.get(url)
        
        WebDriverWait(driver, 20).until(EC.presence_of_element_located((By.CSS_SELECTOR, "div.fw-li")))
        active_proxies = driver.find_elements(By.CSS_SELECTOR, "div.fw-li:not(.-archive)")
        proxies_to_process = min(4, len(active_proxies))
        print(f"[SCRAPER] Found {len(active_proxies)} active proxies. Processing up to {proxies_to_process}.")

        for i in range(proxies_to_process):
            try:
                # Re-find elements in each loop iteration to avoid StaleElementReferenceException
                current_proxies = driver.find_elements(By.CSS_SELECTOR, "div.fw-li:not(.-archive)")
                if i >= len(current_proxies):
                    print("[SCRAPER] No more proxies to process.")
                    break
                
                proxy_to_click = current_proxies[i]
                driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", proxy_to_click)
                time.sleep(1) # Allow time for scrolling
                driver.execute_script("arguments[0].click();", proxy_to_click)
                
                # Wait for modal and interact
                get_creds_button = WebDriverWait(driver, 20).until(EC.element_to_be_clickable((By.CSS_SELECTOR, "button.proxy-get-creds-btn")))
                get_creds_button.click()
                address_input = WebDriverWait(driver, 20).until(EC.visibility_of_element_located((By.ID, "address")))
                address_input.send_keys("onlineproxy.io")
                get_button = WebDriverWait(driver, 20).until(EC.element_to_be_clickable((By.CSS_SELECTOR, ".creds-modal .actions button.submit-btn")))
                get_button.click()
                WebDriverWait(driver, 20).until(EC.presence_of_element_located((By.CSS_SELECTOR, "div.i-creds")))
                time.sleep(2) # Wait for credentials to load fully
                
                def find_text_by_label(label_text):
                    try:
                        xpath = f"//div[contains(@class, 'label') and normalize-space(.)='{label_text}']/following-sibling::div//div[contains(@class, 'copy-input')]/span"
                        element = driver.find_element(By.XPATH, xpath)
                        return driver.execute_script("return arguments[0].textContent;", element).strip()
                    except:
                        return None
                
                # Scrape all individual components
                protocol = driver.find_element(By.CSS_SELECTOR, "div.dd.i-protocol .content-slot").text.lower()
                login, password, ip, port = find_text_by_label("Login"), find_text_by_label("Password"), find_text_by_label("IP address"), find_text_by_label("Port")
                
                if all([protocol, login, password, ip, port]):
                    proxy_data = {"protocol": protocol, "login": login, "password": password, "ip": ip, "port": port}
                    scraped_proxies_data.append(proxy_data)
                
                # Close the modal safely
                close_button = WebDriverWait(driver, 20).until(EC.element_to_be_clickable((By.XPATH, "//button[.//span[contains(text(), 'Close')]]")))
                close_button.click()
                WebDriverWait(driver, 20).until(EC.invisibility_of_element_located((By.CSS_SELECTOR, "div.proxy-creds-window")))
                time.sleep(1)
            except (TimeoutException, WebDriverException) as e:
                print(f"[SCRAPER] Error processing a proxy, refreshing and trying next. Error: {type(e).__name__}")
                driver.refresh() # Refresh the page to reset state
                continue
    finally:
        if 'driver' in locals():
            driver.quit()
    return scraped_proxies_data

# --- TELEGRAM BOT COMMAND HANDLERS ---

async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    country_list = "\n".join([f"`{name}`" for name in COUNTRY_URLS.keys()])
    welcome_text = (
        "*Welcome to the Proxy Scraper Bot\\!* 🤖\n\n"
        "Here are the available countries:\n"
        f"{country_list}\n\n"
        "To get proxies, use the `/proxy <country_name>` command\\.\n"
        "Example: `/proxy united-states`\n\n"
        "Type /help for more info\\."
    )
    # The text is already escaped, so we can use reply_markdown_v2
    await update.message.reply_markdown_v2(welcome_text)

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    help_text = (
        "*How to use this bot:*\n\n"
        "Use the `/proxy` command followed by a country name to get proxies\\.\n\n"
        "*Format:*\n`/proxy <country_name>`\n\n"
        "*Example:*\n`/proxy germany`\n\n"
        "Use /start to see the full list of supported countries\\."
    )
    await update.message.reply_markdown_v2(help_text)

async def proxy_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_markdown_v2("Please specify a country\\. Use `/help` for instructions\\.")
        return

    country = context.args[0].lower()
    if country not in COUNTRY_URLS:
        await update.message.reply_markdown_v2(f"Sorry, '{escape_markdown_v2(country)}' is not a valid country\\. Use /start to see the list\\.")
        return

    url = COUNTRY_URLS[country]
    # Use escape_markdown_v2 for user-provided input
    message_text = f"✅ Got it\\! Scraping proxies for *{escape_markdown_v2(country)}*\\.\\.\\. This may take a minute\\."
    await update.message.reply_markdown_v2(message_text)

    try:
        scraped_proxies_data = await asyncio.to_thread(get_proxy_details, url)
        
        if not scraped_proxies_data:
            message_text = f"😥 Couldn't find any working proxies for *{escape_markdown_v2(country)}* right now\\. Please try again later\\."
            await update.message.reply_markdown_v2(message_text)
            return

        # --- IMPROVEMENT: Combine messages into one ---
        response_lines = [f"🎉 Success\\! Found *{len(scraped_proxies_data)}* proxies for *{escape_markdown_v2(country)}*\\:"]
        
        for i, proxy_data in enumerate(scraped_proxies_data):
            full_proxy_string = (
                f"{proxy_data['protocol']}://{proxy_data['login']}:{proxy_data['password']}"
                f"@{proxy_data['ip']}:{proxy_data['port']}"
            )
            response_lines.append(f"\n*Proxy {i+1}:*\n`{escape_markdown_v2(full_proxy_string)}`")

        final_message = "\n".join(response_lines)
        await update.message.reply_markdown_v2(final_message)

    except Exception as e:
        logging.error(f"An error occurred in proxy_command: {e}", exc_info=True)
        await update.message.reply_markdown_v2("An unexpected error occurred\\. The developer has been notified\\.")

# --- MAIN BOT FUNCTION ---
if __name__ == "__main__":
    logging.basicConfig(format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO)
    
    if not TELEGRAM_BOT_TOKEN:
        print("FATAL: TELEGRAM_BOT_TOKEN environment variable not set.")
        print("Please set it before running the script.")
        exit(1)

    print("Bot is starting...")
    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("proxy", proxy_command))
    
    print("Bot is polling...")
    application.run_polling()