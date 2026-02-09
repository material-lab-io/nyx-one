---
name: instamart
description: "Order groceries from Swiggy Instamart. Build cart, add items, quick grocery shopping."
metadata: {"clawdbot":{"emoji":"🛒","requires":{"config":["browser.enabled"]}}}
---

# Swiggy Instamart Grocery Ordering

Quick grocery ordering from Swiggy Instamart - build carts, add items, checkout.

## Phone Access Control

**BEFORE using any Instamart tool**, check the caller's phone number against the allowlist.

1. Read `/root/clawd/.swiggy-allow-phones` (contains comma-separated phone suffixes/numbers, e.g. `*0848`)
2. Check if the current user's phone number matches any entry:
   - `*XXXX` means "ends with XXXX"
   - A full number like `+91XXXXXXXXXX` means exact match
3. If NO match: respond "Sorry, Swiggy ordering is not enabled for your number." and **stop**.
4. If match: proceed normally.

## User Preferences (Encoded)

**Address:** Home - Prestige North Point, HRBR Layout, Kalyan Nagar, Bengaluru 560043
**Diet:** Vegetarian only (no meat, fish, eggs in groceries)
**Dietary Restrictions:** Gluten-free, no milk (dairy like paneer/curd OK - low lactose), no soya

## Headcount System

**Default:** 2 people
**Current Override:** 1 person (Jan 26-29, 2026)

Quantities auto-scale based on headcount:
- 1 person: Use base quantities as listed
- 2 people: Double quantities
- Perishables (vegetables, fruits): Scale to avoid waste

## Current Inventory (Skip These)

| Item | Status | Notes |
|------|--------|-------|
| Apples | Have 2 | Skip ordering |
| Dry fruits | Recently ordered | Skip (almonds, walnuts, etc.) |

## Need to Restock (Priority)

| Item | Status |
|------|--------|
| Whey Protein Isolate (1kg) | Running low - usual size |
| Tender Coconuts | Out (prefer tender, not regular coconuts) |
| Lemons | Out |

## Favorites (Auto-discovered)

### Frequently Ordered Items

| Item | Brand/Type | Typical Price |
|------|------------|---------------|
| Whey Protein Isolate | 1kg pack (usual) | ~₹1500 |
| Tender Coconuts | 3 pcs | ~₹90 |
| Paneer | 400g | ~₹180 |
| Protein Bars (20g) | The Whole Truth | ~₹584 |
| Bananas | Yelakki (Baalehannu) | ~₹45 |
| Lemons | 6 pcs | ~₹30 |
| Club Soda | Bisleri 750ml | ~₹12 |
| Cotton Earbuds | Johnson & Johnson | ~₹80 |
| Mixed Dry Fruits | Farmley Panchmeva | ~₹449 |

### Quick Reorder Lists

**"Usual Fruits"** - search: `banana`, `tender coconut`
- Yelakki Banana (Baalehannu)
- Tender Coconuts

**"Protein Snacks"** - search: `protein bar`, `dry fruits`
- The Whole Truth 20G Protein Bars
- Farmley Mix Dry Fruits Panchmeva

**"Protein Staples"** - search: `whey`, `paneer`
- Whey Protein Isolate 1kg
- Paneer 400g

**"Beverages"** - search: `soda`
- Bisleri Club Soda 750ml

### Suggested Reorder Bundles

**Weekly Essentials (~₹150)**
- Bananas
- Club Soda
- Lemons

**Healthy Snacks (~₹1033)**
- Protein Bars
- Dry Fruits

**Full Restock (~₹1900)**
All favorites: whey protein, tender coconuts, paneer, bananas, lemons, soda

### Complete Nutrition Cart (GF, No Milk, No Soya) - 4 Days, 1 Person

**Macros Target (per day):** Protein 50-60g | Carbs 200-250g | Fat 50-65g | Fiber 25-30g

**Priority Restocks:**
- Whey Protein Isolate 1kg (~₹1500)
- Tender Coconuts 3 pcs (~₹90)
- Lemons 6 pcs (~₹30)

**Protein Sources:**
| Item | Qty | Protein | Notes |
|------|-----|---------|-------|
| Paneer | 400g | 72g | Low lactose OK |
| Curd (Mother Dairy) | 2x400g | 28g | Probiotics, B12 |
| Toor/Arhar Dal | 500g | ~110g | Complete protein w/rice |
| Moong Dal | 250g | ~60g | Easy digest, GF |
| ~~Soy Chunks~~ | SKIP | Don't like |

**Vegetables:** (Order separately when needed)
| Item | Qty | Key Nutrients |
|------|-----|---------------|
| Spinach (Palak) | 250g | Iron, folate, Vit K |
| Tomatoes | 500g | Vit C (iron absorption) |
| Onions | 500g | Cooking base |
| Potatoes | 500g | Carbs, potassium, GF |
| Carrots | 250g | Vit A, fiber |
| Capsicum | 200g | Vit C |
| Beans | 250g | Fiber |
| Ginger | 50g | Immunity |
| Garlic | 50g | Immunity |

**Fruits:**
| Item | Qty | Key Nutrients |
|------|-----|---------------|
| Bananas (Yelakki) | 1 bunch | Potassium, energy |
| ~~Apples~~ | SKIP | Already have |

**Grains - Gluten Free:** (Order separately when needed)
| Item | Qty | Notes |
|------|-----|-------|
| Rice | 1kg | Base carb, GF |
| Poha | 250g | Quick breakfast, GF |
| Idli/Dosa batter | 500g | Ready-to-use, GF |

**Healthy Fats:** (Order separately when needed)
| Item | Qty | Notes |
|------|-----|-------|
| Ghee | 200g | Cooking fat, Vit D |
| Coconut oil | 200ml | Healthy fat |
| Flaxseeds | 100g | Omega-3, fiber |

**Ready Items & Extras:** (Order separately when needed)
| Item | Qty | Notes |
|------|-----|-------|
| Almond milk | 1L | For protein shakes |
| Peanut butter | 200g | Protein, energy |

## Daily Meal Framework (GF, No Milk, No Soya)

**Breakfast:** Protein shake (whey + water) + banana
**Lunch:** Dal + paneer | Fresh tender coconut
**Snacks:** Dry fruits | Fruit | Protein shake
**Dinner:** Paneer + vegetables | Protein shake

## Safety Rules

- **NEVER CHECKOUT OR PURCHASE** - Agent builds cart only. User completes purchase manually.
- **NO payment actions** - Do not click "Proceed to Pay", "Place Order", or any payment buttons
- Build cart → show summary → notify user "Cart ready for your review" → STOP
- User will open Swiggy app/website and complete purchase themselves

## Daily Cron: Auto-Build Cart

The agent can automatically build a grocery cart each morning based on favorites and the shopping list.

### Setup Cron Job
```json
{
  "action": "add",
  "job": {
    "id": "instamart-daily",
    "label": "Daily Grocery Cart",
    "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Kolkata" },
    "payload": {
      "kind": "agentTurn",
      "message": "Build my daily Instamart cart. Check shopping list, add Weekly Essentials, notify me when ready.",
      "deliver": true,
      "channel": "last"
    }
  }
}
```

### Daily Cart Logic
1. Check Shopping List (below) for user-requested items
2. Add Weekly Essentials bundle (bananas, lemons, soda)
3. Add any shopping list items
4. Show cart summary
5. Notify: "Morning grocery cart ready: [X items, ₹Y]. Review in Swiggy app."
6. Clear shopping list items that were added

### Manage Cron
- List jobs: `{"action": "list"}`
- Disable: `{"action": "update", "jobId": "instamart-daily", "patch": {"enabled": false}}`
- Change time: `{"action": "update", "jobId": "instamart-daily", "patch": {"schedule": {"kind": "cron", "expr": "0 7 * * *", "tz": "Asia/Kolkata"}}}`
- Remove: `{"action": "remove", "jobId": "instamart-daily"}`

## Shopping List

User can add items throughout the day to be included in the next cart build.

### Current Shopping List
<!-- Agent maintains this list, adding/removing as requested -->
| Item | Quantity | Added | Notes |
|------|----------|-------|-------|
| (empty) | - | - | - |

### Shopping List Commands

**"Add [item] to shopping list"** / **"Remember to get [item]"**
1. Add item to the Shopping List table above
2. Confirm: "Added [item] to shopping list. Will include in next cart."

**"What's on my shopping list?"** / **"Show shopping list"**
1. Display current shopping list
2. Show estimated total if prices known

**"Remove [item] from shopping list"** / **"Don't need [item]"**
1. Remove item from shopping list
2. Confirm removal

**"Clear shopping list"**
1. Empty the shopping list table
2. Confirm: "Shopping list cleared"

## Nutrition Tracking

Track nutrition data from completed orders to monitor intake over time.

### Order Log
<!-- Agent logs completed orders here for nutrition tracking -->
| Date | Items | Est. Calories | Protein | Notes |
|------|-------|---------------|---------|-------|
| (no orders logged yet) | - | - | - | - |

### Nutrition Reference (Complete)
| Item | Serving | Calories | Protein | Carbs | Fat | Key Micros |
|------|---------|----------|---------|-------|-----|------------|
| **Protein Sources** |
| Whey Protein Isolate | 30g scoop | ~120 | 25g | 2g | 1g | B12, calcium |
| Paneer | 100g | ~265 | 18g | 3g | 20g | Calcium, B12 |
| Curd (Mother Dairy) | 400g | ~240 | 14g | 18g | 12g | B12, calcium, probiotics |
| Toor Dal | 100g dry | ~340 | 22g | 63g | 1g | Iron, folate, fiber |
| Moong Dal | 100g dry | ~350 | 24g | 60g | 1g | Iron, folate |
| Soy Chunks | 100g dry | ~345 | 52g | 33g | 0.5g | Complete protein, iron |
| **Vegetables** |
| Spinach (Palak) | 100g | ~23 | 3g | 4g | 0.4g | Iron, folate, Vit K, Vit A |
| Tomatoes | 100g | ~18 | 0.9g | 4g | 0.2g | Vit C, lycopene |
| Potatoes | 100g | ~77 | 2g | 17g | 0.1g | Potassium, Vit C, B6 |
| Carrots | 100g | ~41 | 0.9g | 10g | 0.2g | Vit A (beta-carotene) |
| Capsicum | 100g | ~20 | 0.9g | 5g | 0.2g | Vit C |
| Beans | 100g | ~31 | 1.8g | 7g | 0.1g | Fiber, folate |
| Coconut (fresh) | 100g | ~354 | 3g | 15g | 33g | MCTs, fiber, manganese |
| **Fruits** |
| Bananas (Yelakki) | 1 bunch (~6) | ~530 | 6g | 135g | 2g | Potassium, B6 |
| Oranges/Mosambi | 100g | ~47 | 0.9g | 12g | 0.1g | Vit C |
| Apples | 100g | ~52 | 0.3g | 14g | 0.2g | Fiber |
| Lemons | 1 pc | ~17 | 0.6g | 5g | 0.2g | Vit C |
| **Grains (GF)** |
| Rice (cooked) | 100g | ~130 | 2.7g | 28g | 0.3g | - |
| Poha | 100g dry | ~360 | 7g | 77g | 1g | Iron (fortified) |
| Idli/Dosa batter | 100g | ~150 | 4g | 30g | 0.5g | Fermented, B vitamins |
| **Fats** |
| Ghee | 1 tbsp | ~120 | 0g | 0g | 14g | Vit A, D, E, K |
| Coconut oil | 1 tbsp | ~120 | 0g | 0g | 14g | MCTs |
| Flaxseeds | 1 tbsp | ~55 | 2g | 3g | 4g | Omega-3, fiber |
| Peanut butter | 2 tbsp | ~190 | 8g | 6g | 16g | Protein, healthy fats |
| **Extras** |
| Almond milk | 240ml | ~40 | 1g | 3g | 3g | Calcium (fortified), Vit D |
| Protein Bars (Whole Truth) | 1 bar | ~200 | 20g | 15g | 8g | - |
| Dry Fruits (Panchmeva) | 100g | ~450 | 12g | 35g | 30g | Iron, zinc |

### Nutrition Commands

**"Log my order"** / **"I ordered the cart"**
1. Record current date and cart items to Order Log
2. Calculate estimated nutrition from Nutrition Reference
3. Confirm: "Logged order: [items]. Est. ~X calories, Yg protein today."

**"Show my nutrition this week"** / **"Weekly nutrition summary"**
1. Aggregate Order Log for past 7 days
2. Show: total calories, protein, averages
3. Note any patterns or suggestions

**"What's my protein intake?"**
1. Sum protein from recent orders
2. Compare to daily goal (if set)

### Weekly Nutrition Summary
<!-- Auto-updated weekly -->
- **This week:** (no data yet)
- **Avg daily calories:** -
- **Avg daily protein:** -
- **Top items:** -

## Key URLs

- Instamart home: `https://www.swiggy.com/instamart`
- Direct to Instamart: Click "INSTAMART" or "IM" button on swiggy.com homepage

## Navigation

### Getting to Instamart
1. Go to `https://www.swiggy.com`
2. Click the "INSTAMART" button (shows "INSTANT GROCERY" / "30 MINS OR LESS")
3. Verify address shows "Prestige" or "HRBR" - fix if wrong

### Key UI Elements
- **Search bar**: Search for grocery items
- **Categories**: Browse by category (Fruits, Vegetables, Dairy, etc.)
- **Cart button**: Top right, shows item count and total
- **My Account**: Top right, for account settings

## Workflow: Build Cart

### 1. Open Instamart
```json
{"action": "start", "profile": "clawd"}
{"action": "open", "targetUrl": "https://www.swiggy.com/instamart", "profile": "clawd"}
```

### 2. Dismiss Popups FIRST (Critical!)
Before any interaction, check for and dismiss popups:
- Look for "Got it!", "OK", "X", "Close" buttons
- Common popups: location confirmation, offers, app download prompts
- Click dismiss buttons before trying to interact with products
```json
{"action": "snapshot", "profile": "clawd", "interactive": true}
```
Look for popup dismiss buttons and click them first.

### 3. Search for Items
Direct search URL is most reliable:
```json
{"action": "navigate", "targetUrl": "https://www.swiggy.com/instamart/search?query=ITEM_NAME", "profile": "clawd"}
```
Replace ITEM_NAME with the search term (e.g., "curd", "milk", "bread").

### 4. Add Items to Cart
After search results load:
1. Take snapshot to find ADD buttons
2. **Dismiss any popups first** (Got it, OK, X buttons)
3. Click the "ADD" or "+" button on the product
4. If ADD doesn't work, try clicking the product card first, then ADD from detail view
5. Verify cart count increased

**If ADD button doesn't respond:**
- Try pressing Escape first: `{"action": "act", "profile": "clawd", "request": {"kind": "press", "key": "Escape"}}`
- Take fresh snapshot after Escape
- Try clicking ADD again

### 5. View Cart
```json
{"action": "navigate", "targetUrl": "https://www.swiggy.com/instamart/checkout", "profile": "clawd"}
```
Or click cart button (shows "X items ₹Y" in top right).

### 6. Review Cart & Notify User
- Show cart summary: items, quantities, total
- Present: "Cart ready: [items list] | Total: ₹X | [X items]"
- Notify: "Please open Swiggy app/website to review and complete your purchase."
- **STOP HERE** - Do not proceed to checkout or payment

## Popup Handling

**IMPORTANT:** Instamart often has popups that block interactions. Always:

1. After any page load, press Escape first:
```json
{"action": "act", "profile": "clawd", "request": {"kind": "press", "key": "Escape"}}
```

2. Take snapshot and look for dismiss buttons:
- "Got it!" - click to dismiss
- "X" or close icons - click to close modals
- "OK" / "Allow" / "Not Now" - handle location/notification prompts

3. If clicking doesn't work, try:
- Press Escape again
- Click somewhere neutral (page background)
- Refresh and try again

## Common Commands

### "Order my usual groceries" / "Reorder favorites" / "Get my usual"
1. Open Instamart
2. Reference the Favorites section above
3. Ask: "Want your usual? I can add: [Weekly Essentials / Healthy Snacks / Full Restock]"
4. Add items from selected bundle
5. Show cart summary and notify: "Cart ready - please complete purchase in Swiggy app"

### "Order my usual fruits" / "Get bananas"
1. Open Instamart
2. Search and add: Yelakki Banana, Tender Coconuts
3. Show updated cart

### "Weekly grocery run" / "Restock basics"
1. Add Weekly Essentials bundle: bananas, lemons, soda
2. Ask if protein snacks should be included
3. Show cart and notify user to complete purchase

### "Add [item] to Instamart cart" / "Get [item] from Instamart"
1. Open Instamart
2. Search for item
3. Click ADD on best match
4. Confirm: "Added [item] to cart"

### "Show my Instamart cart" / "What's in my cart?"
1. Open Instamart
2. Click cart button
3. List all items with prices and total

### "Order groceries" / "Instamart order"
1. Open Instamart
2. Ask what items to add, OR show current cart
3. Build cart as requested
4. Review and confirm before checkout

### "Add bananas and paneer"
1. Open Instamart
2. Search "banana", add
3. Search "paneer", add
4. Show updated cart

### "Clear cart" / "Empty cart" / "Start fresh"
1. Open cart: `https://www.swiggy.com/instamart/checkout`
2. For each item, click the "-" button repeatedly or "Remove" to delete
3. Continue until cart is empty
4. Confirm: "Cart cleared"

### "Remove [item]" / "Take out [item]"
1. Open cart
2. Find the specified item
3. Click "-" or "Remove" to delete it
4. Show updated cart

### "Checkout" / "Place order" / "Buy now"
**BLOCKED** - Agent does not complete purchases.
1. Show cart summary (items, quantities, total)
2. Reply: "Cart ready for review: [X items, ₹Y total]. Please open Swiggy to complete your purchase."
3. STOP - do not proceed to payment

### "Set up daily grocery cart" / "Enable auto-cart"
1. Use cron tool to add the `instamart-daily` job (see Daily Cron section)
2. Confirm: "Daily cart enabled. Will build at 8am IST with Weekly Essentials + shopping list."

### "Stop daily cart" / "Disable auto-cart"
1. Use cron tool to disable: `{"action": "update", "jobId": "instamart-daily", "patch": {"enabled": false}}`
2. Confirm: "Daily cart paused. Re-enable anytime."

### "Change cart time to [X]am"
1. Update cron schedule with new time
2. Confirm new schedule

### "I placed the order" / "Order complete" / "Log order"
1. Note current cart items
2. Add entry to Order Log with date, items, nutrition estimates
3. Confirm: "Logged! [items] - ~Xkcal, Yg protein"
4. Optionally clear cart or keep for next order

## Browser Tool Reference

```json
// Start browser
{"action": "start", "profile": "clawd"}

// Open URL
{"action": "open", "targetUrl": "https://www.swiggy.com/instamart", "profile": "clawd"}

// Screenshot (see page state)
{"action": "screenshot", "profile": "clawd"}

// Snapshot (get clickable refs)
{"action": "snapshot", "profile": "clawd", "interactive": true}

// Click element
{"action": "act", "profile": "clawd", "request": {"kind": "click", "ref": "e123"}}

// Type text
{"action": "act", "profile": "clawd", "request": {"kind": "type", "ref": "e456", "text": "milk"}}

// Scroll down
{"action": "act", "profile": "clawd", "request": {"kind": "press", "key": "PageDown"}}
```

## Tips

- **Order History Note:** My Account → Orders shows food delivery only. Instamart history may be in cart's "Buy Again" section or a separate Instamart profile area. Update favorites as new items are discovered.
- Items may be out of stock - check availability and inform user
- Delivery slots may vary - show available slots if relevant
- Keep it fast: address is pre-set, just verify silently
