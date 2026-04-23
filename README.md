# YNAB Business Income/Expense Tracking in Thymer
YNAB dashboard, income chart on journal pages, transaction sync

‼️ In progress. Created by AI, vibes, and someone who knows nothing about coding! Suggestions and support very welcome! ‼️



# YNAB × Thymer Integration

A comprehensive financial dashboard plugin that brings your YNAB budget into Thymer with real-time transaction sync, interactive charts, and flexible filtering.

## Features

- 📊 **Dashboard** — Visual overview with income vs. expenses, category breakdowns, and monthly trends
- 💰 **Income Chart** — Daily/Weekly/Monthly income views with comparisons to last period and rolling averages
- 🔄 **Transaction Sync** — Pull all your YNAB transactions into a searchable, organized collection
- 📋 **Multiple Views** — Dashboard, Income vs Expenses board, and Receipts table
- ⚙️ **Smart Filtering** — Choose exactly which payees count as income and which expense categories to track
- 📱 **Journal Integration** — Income chart appears automatically above Properties on journal pages
- 💾 **Storage Mode** — Command Palette `YNAB: Storage location…` supports local-only or synced settings

## Recent sync updates

- Added embedded Path B runtime for synced settings support.
- Added `YNAB: Storage location…` command.
- Improved journal panel repopulation/navigation behavior.
- Manual sync remains explicit (`Sync Now` / command), no auto-sync on load.
- Updated collection JSON to full plugin schema format (`ver`, `name`, views, metadata).

## Prerequisites

- Thymer account and installed (https://thymer.com)
- YNAB account (free or paid, https://www.ynab.com)
- YNAB Personal Access Token (takes 2 minutes to generate)

## Installation

### Step 1: Get Your YNAB Personal Access Token

1. Go to **app.ynab.com** → Sign in
2. Click your **Account icon** (top left) → **Account Settings**
3. Scroll to **Developer Settings** → **Personal Access Tokens**
4. Click **Generate Token**
5. Give it a name like "Thymer Integration"
6. **Copy the token** (you'll only see it once!) and save it somewhere temporarily
7. Click **Confirm**

> ⚠️ **Never share this token.** It gives access to your budget data. Keep it private.

### Step 2: Create the YNAB Collection in Thymer

1. Open **Thymer**
2. Create a new collection called **`YNAB`**
3. Go to **Settings** (gear icon on the collection)
4. Click **Edit as Code** → **Configuration** tab
5. Delete any existing content and paste the entire contents of **`plugin.json`**
6. Click **Save** (you should see "Configuration updated")

### Step 3: Install the Plugin Code

1. Still in **Settings** → **Edit as Code**
2. Go to the **Custom Code** tab
3. Delete any existing content and paste the entire contents of **`plugin.js`**
4. Click **Save** (you should see "Code compiled")
5. Click **Reload** (Thymer will refresh)

### Step 4: Configure Your Token & Budget

1. Open **Command Palette** (Cmd/Ctrl + K)
2. Search for **`YNAB: Configure Token & Budget`** and press Enter
3. A dialog will appear with two fields:
   - **Personal Access Token** — Paste the token you generated in Step 1
   - **Budget** — Click "Load Budgets" to fetch your YNAB budgets
   - Select your budget from the dropdown
4. Click **Apply** to save

You'll see a confirmation: "Token and budget saved."

### Step 5: Sync Your Transactions

1. Go to the **YNAB collection** → **Dashboard** view
2. Click the **Sync Now** button (⟳ icon, top right)
3. Wait for the sync to complete (may take a few seconds for large budgets)
4. Your transactions will appear in the collection

### Optional: Choose settings storage mode

1. Open Command Palette (Cmd/Ctrl + K)
2. Run **`YNAB: Storage location…`**
3. Choose:
   - **This device only** (localStorage)
   - **Sync via Plugin Settings** (workspace-synced)

## Usage

### Dashboard View

The main overview shows:
- **Income & Expense totals** for your selected date range
- **Monthly chart** with a line graph of spending trends
- **Category group breakdown** showing how much you spent in each category
- **Wages/Draw callout** highlighting salary or owner draw transactions
- **Taxes Paid section** (collapsible) with a separate tax export

**Date Range:** Use the dropdown in the top left to switch between This Month, Last Month, YTD, Last 90 Days, and custom ranges.

### Income Chart on Journal Pages

When you open a journal page, you'll see an **Income Chart** widget at the top:
- **View Options** — Switch between Daily, Weekly, or Monthly views
- **Chart Type** — Toggle between Bar and Line charts
- **Overlays** — Compare to last period or show rolling averages
- **Settings** — Click the ⚙️ icon to filter:
  - Which payees count as "income" (checkboxes with dollar amounts)
  - Which expense categories to include/exclude

### Other Views

- **Income vs Expenses** — Board view grouped by transaction type (Income/Expense)
- **Receipts** — Table view showing transactions with receipt uploads

### Manual Sync

To refresh your data anytime, click **Sync Now** on the Dashboard. The plugin automatically caches data for 15 minutes to avoid excessive API calls.

## How It Works

- **API Connection** — The plugin fetches your transactions and categories from the YNAB API
- **Local Storage** — Your token and budget ID are stored in your browser's localStorage (never sent anywhere)
- **Filtering** — Income and expense filters are configurable and saved to your Thymer account
- **Caching** — Data is cached for 15 minutes to reduce API calls and improve performance

## Troubleshooting

### "Configure YNAB token" message on Dashboard

The token hasn't been set yet. Go to **Command Palette** → **YNAB: Configure Token & Budget** and follow the setup steps.

### Sync isn't working

1. Check that your token is still valid (tokens don't expire, but can be revoked)
2. Make sure you selected a budget in the config dialog
3. Try clicking **Sync Now** again
4. Check your browser console (F12 → Console tab) for error messages

### Income chart not showing on journal pages

1. Make sure you're on a **journal page** (not a regular collection record)
2. Try reloading Thymer
3. Check if the widget is collapsed — scroll down to see it

### "YNAB [401]" error

Your token is invalid or expired. Generate a new one in YNAB Account Settings → Developer Settings and update the plugin config.

## Privacy & Security

- ✅ Your token is stored **locally in your browser only** — never sent to anyone except the YNAB API
- ✅ All data syncing happens **in-browser** — no third-party servers involved
- ✅ Your budget data never leaves your computer (except when fetching from YNAB)
- ⚠️ If you share your Thymer settings with someone, they'll see your synced transaction data and your YNAB configuration

## Support

For issues or feature requests, check the plugin handoff documentation (`YNAB_PLUGIN_HANDOFF.md`) for technical details and known patterns.

---

**Handoff created March 2026** — Customized for public distribution
