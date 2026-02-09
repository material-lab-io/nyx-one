---
name: swiggy
description: "Browse food and groceries from Swiggy using mcporter CLI. Search restaurants, view menus, and build carts."
metadata: {"clawdbot":{"emoji":"🍕","requires":{"bins":["mcporter"]}}}
---

# Swiggy Browsing Skill

Browse food and groceries from Swiggy using `mcporter` CLI to call MCP tools.

**NOTE: Order placement is DISABLED. Use the Swiggy app to place orders.**

## Phone Access Control

**BEFORE using any Swiggy tool**, check the caller's phone number against the allowlist.

1. Read `/root/clawd/.swiggy-allow-phones` (contains comma-separated phone suffixes/numbers, e.g. `*0848`)
2. Check if the current user's phone number matches any entry:
   - `*XXXX` means "ends with XXXX"
   - A full number like `+91XXXXXXXXXX` means exact match
3. If NO match: respond "Sorry, Swiggy ordering is not enabled for your number." and **stop**.
4. If match: proceed normally.

## How to Call Swiggy Tools

Use the exec tool to run mcporter commands:
```bash
mcporter call swiggy-food.<tool> key=value key2=value2
```

For complex arguments, use `--args` with JSON:
```bash
mcporter call swiggy-food.update_food_cart --args '{"restaurantId":"123","cartItems":[...]}'
```

## Available Services

- **swiggy-food**: Restaurant food delivery (browsing + cart)
- **swiggy-instamart**: Grocery and essentials (browsing + cart)

## User Preferences

**VEGETARIAN ONLY** - Always use `vegFilter=1` when searching for food.

**DEFAULT ADDRESS: Home - HRBR Layout**
- When calling `get_addresses`, look for address containing "HRBR" or "Kalyan Nagar" or "1121"
- Use that `id` value as `addressId` for all subsequent calls
- Do NOT ask user to confirm address - just use Home automatically

## Safety Rules

- **ORDER PLACEMENT DISABLED** - Do NOT call place_food_order or checkout
- **Cart only** - You can search, browse, and build carts but NOT place orders
- **To order**: Tell user to open Swiggy app where cart will be synced

---

## Swiggy Food Tools

### get_addresses
Get saved delivery addresses.
```bash
mcporter call swiggy-food.get_addresses
```

### search_restaurants
Search restaurants by name or cuisine.
```bash
mcporter call swiggy-food.search_restaurants addressId=ckl8eaot4lpv5u0ojdhg query="biryani"
```

### search_menu
Search for specific dishes. Use `vegFilter=1` for vegetarian.
```bash
mcporter call swiggy-food.search_menu addressId=ckl8eaot4lpv5u0ojdhg query="paneer tikka" vegFilter=1
```

Optionally scope to a restaurant:
```bash
mcporter call swiggy-food.search_menu addressId=ckl8eaot4lpv5u0ojdhg query="dosa" vegFilter=1 restaurantIdOfAddedItem=123456
```

### get_food_cart
View current cart contents.
```bash
mcporter call swiggy-food.get_food_cart
```

### update_food_cart
Add items to cart. Use `--args` for complex structure:
```bash
mcporter call swiggy-food.update_food_cart --args '{
  "restaurantId": "123456",
  "cartItems": [
    {
      "menu_item_id": "item123",
      "quantity": 1,
      "variants": [{"group_id": "g1", "variation_id": "v1"}]
    }
  ]
}'
```

**Important for variants:**
- Items have EITHER `variations` OR `variantsV2` format - use the same format returned by search
- After adding with variants, check cart response `valid_addons` to see available addons

### flush_food_cart
Clear the entire cart.
```bash
mcporter call swiggy-food.flush_food_cart
```

### fetch_food_coupons
Get available coupons.
```bash
mcporter call swiggy-food.fetch_food_coupons restaurantId=123456 addressId=ckl8eaot4lpv5u0ojdhg
```

### apply_food_coupon
Apply a coupon to the order.
```bash
mcporter call swiggy-food.apply_food_coupon couponCode=SWIGGY50 addressId=ckl8eaot4lpv5u0ojdhg
```

### get_food_orders
Get active/recent orders.
```bash
mcporter call swiggy-food.get_food_orders orderCount=5
```

### get_food_order_details
Get details for a specific order.
```bash
mcporter call swiggy-food.get_food_order_details orderId=ORDER123
```

### track_food_order
Track order status and delivery progress.
```bash
mcporter call swiggy-food.track_food_order orderId=ORDER123
```

---

## Swiggy Instamart Tools

### get_addresses
Same as food - get saved addresses.
```bash
mcporter call swiggy-instamart.get_addresses
```

### search_products
Search for grocery products.
```bash
mcporter call swiggy-instamart.search_products addressId=ckl8eaot4lpv5u0ojdhg query="milk"
```

### get_cart
View Instamart cart.
```bash
mcporter call swiggy-instamart.get_cart
```

### update_cart
Add/update items in Instamart cart.
```bash
mcporter call swiggy-instamart.update_cart --args '{
  "addressId": "ckl8eaot4lpv5u0ojdhg",
  "items": [{"productId": "prod123", "quantity": 2}]
}'
```

### clear_cart
Clear Instamart cart.
```bash
mcporter call swiggy-instamart.clear_cart
```

### get_orders
Get Instamart order history.
```bash
mcporter call swiggy-instamart.get_orders
```

---

## Workflow

### 1. Get Address (automatic)
```bash
mcporter call swiggy-food.get_addresses
```
Find address with "HRBR" or "1121" - use that `id` as addressId. Do NOT ask user.

### 2. Search (with veg filter)
```bash
# For food dishes
mcporter call swiggy-food.search_menu addressId=ID query="paneer" vegFilter=1

# For restaurants
mcporter call swiggy-food.search_restaurants addressId=ID query="dominos"

# For groceries
mcporter call swiggy-instamart.search_products addressId=ID query="milk"
```

### 3. Build Cart
Add items using the menu_item_id from search results.

### 4. Review Cart
```bash
mcporter call swiggy-food.get_food_cart
```
Display: items, quantities, prices, total, delivery address.

### 5. To Place Order
Tell user: "Cart is ready! Open the Swiggy app to place your order - the cart will be synced."

---

## Common Tasks

### "Find biryani options"
1. `mcporter call swiggy-food.get_addresses` - find Home addressId (HRBR/1121)
2. `mcporter call swiggy-food.search_menu addressId=ID query="veg biryani" vegFilter=1`
3. Show options
4. If user wants to add: use update_food_cart
5. Show cart summary, tell user to open Swiggy app to order

### "Track my order"
1. `mcporter call swiggy-food.get_food_orders orderCount=5`
2. `mcporter call swiggy-food.track_food_order orderId=ORDER_ID`
3. Show status and ETA

---

## Important Notes

- **ORDER PLACEMENT DISABLED** - Cannot place orders via MCP, use Swiggy app
- **Cart syncs** - Items added here appear in Swiggy app
- **Keep Swiggy app closed** while browsing to avoid session conflicts
- **Token expiry** - Tokens last ~5 days, re-auth if expired
- **Veg filter** - Always apply vegFilter=1 for this user
