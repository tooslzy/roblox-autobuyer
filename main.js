import { HBAClient } from "npm:roblox-bat"

const errorAndExit = (msg) => {
	console.error(msg)
	Deno.exit(1)
}

const cookie = await Deno.readTextFile("./cookie.txt")
	.then((t) => t.trim())
	.catch(() => null)

if (cookie == null) errorAndExit("failed to read ./cookie.txt")
if (!cookie.startsWith("_|WARNING:-DO-NOT-SHARE-THIS")) errorAndExit("invalid cookie format in ./cookie.txt")

const hbaClient = new HBAClient({
	keys: await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
	cookie: `.ROBLOSECURITY=${cookie}; RBXEventTrackerV2=browserId=1`,
})
// console.log(hbaClient)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const USER_AGENT = "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
const requestWithAuth = async (method, url, body, getcsrf) => {
	if (body) body = JSON.stringify(body)

	const headers = await hbaClient.generateBaseHeaders(url, method, true, body)

	const req = {
		method,
		headers: {
			"cookie": `.ROBLOSECURITY=${cookie}; RBXEventTrackerV2=browserId=1`,
			"content-type": "application/json",
			"user-agent": USER_AGENT,
			...headers,
		},
	}

	if (getcsrf) {
		const res = await fetch(url, req)
		const csrf = res.headers.get("x-csrf-token")

		if (!csrf) throw new Error("Failed to generate CSRF token")
		req.headers["x-csrf-token"] = csrf
	}

	if (body) req.body = body

	return await fetch(url, req)
}

const userRes = await requestWithAuth("GET", "https://users.roblox.com/v1/users/authenticated")

if (!userRes.ok) {
	console.error(`failed to authenticate user: ${userRes.status} ${userRes.statusText}`)
	errorAndExit(await userRes.text())
}
const ME = await userRes.json()
console.log(`Hello, ${ME.displayName}!`)
console.log()

const catalogSearch = new URL("https://catalog.roblox.com/v1/search/items/details")
const catalogSearchParams = [
	["Category", "All"],
	["SortAggregation", "AllTime"],
	["SortCurrency", "Free"],
	["SortType", "Updated"],
	["CreatorType", "User"],
	["CreatorTargetId", "1"],
	["CreatorName", "Roblox"],
	["MaxPrice", "0"],
	["MinPrice", "0"],
	["IncludeNotForSale", "false"],
	["sortOrder", "Desc"],
	["limit", "30"],
]
for (const [key, value] of catalogSearchParams) {
	catalogSearch.searchParams.append(key, value)
}
console.log(catalogSearch.toString())
console.log()

async function checkItemOwnership(itemType, itemId) {
	const res = await requestWithAuth("GET", `https://inventory.roblox.com/v1/users/${ME.id}/items/${itemType}/${itemId}`)
	if (!res.ok) throw new Error(`failed to check item ownership: ${res.status} ${res.statusText}`)

	const { data } = await res.json()

	return data.length > 0
}

let purchasesCount = 0
async function purchaseItem(item) {
	purchasesCount = (purchasesCount + 1) % 3
	await sleep(purchasesCount === 0 ? 3e3 : 1e3)

	const detailsRes = await requestWithAuth("POST", "https://apis.roblox.com/marketplace-items/v1/items/details", { itemIds: [item.collectibleItemId] })
	const details = await detailsRes.json()
	const collectibleProductId = details[0].collectibleProductId

	const url = `https://apis.roblox.com/marketplace-sales/v1/item/${item.collectibleItemId}/purchase-item`
	const body = {
		collectibleItemId: item.collectibleItemId,
		collectibleProductId: collectibleProductId,
		expectedCurrency: 1,
		expectedPrice: 0,
		expectedPurchaserId: ME.id,
		expectedPurchaserType: "User",
		expectedSellerId: 1,
		expectedSellerType: "User",
		idempotencyKey: crypto.randomUUID(),
	}

	let tries = 1
	const tryPurchase = async () => {
		const res = await requestWithAuth("POST", url, body, true)
		console.log(res.status, "| try", tries, "|", url)

		if (res.status === 429 && tries <= 5) {
			tries += 1
			await sleep(15e3 * tries)
			return tryPurchase()
		}

		return res
	}
	const res = await tryPurchase()

	return await res.json()
}

while (true) {
	const catalogResponse = await requestWithAuth("GET", catalogSearch.toString())
	if (!catalogResponse.ok) break

	const { nextPageCursor, data } = await catalogResponse.json()

	const items = data.filter((obj) => obj.saleLocationType === "ShopAndAllExperiences")
	const currentCursor = catalogSearch.searchParams.get("cursor")
	console.log(`Items: ${items.length}, Page: ${currentCursor ? currentCursor : "<initial>"}`)
	console.log()

	for (const i of items) {
		const owned = await checkItemOwnership(i.itemType, i.id)
		if (owned) {
			console.log(`Owned "${i.name}" | ${i.itemType} | ID: ${i.id}`)
		} else {
			console.log(`Purchasing "${i.name}" | ${i.itemType} | ID: ${i.id}`)
			const purchaseData = await purchaseItem(i)
			console.log(`Purchased: ${purchaseData.purchased ? "✅" : "❌"}`)
			if (!purchaseData.purchased) {
				console.log(purchaseData)
			}
			console.log()
		}
	}

	if (nextPageCursor) {
		catalogSearch.searchParams.set("cursor", nextPageCursor)
	} else {
		break
	}

	await new Promise((r) => setTimeout(r, 1500))
}
