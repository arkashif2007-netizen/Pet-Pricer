package com.freebuff.starpets.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * HTTP client for the scanner backend.
 *
 * Deliberately dependency-light: `HttpURLConnection` plus Android's built-in
 * `org.json`, so there is no serialization library to keep in step with the
 * server. Swapping in Retrofit or Ktor is a drop-in change behind this class.
 *
 * The client never talks to the market directly. It reads the local snapshot
 * that the collector maintains, so the phone is not the thing getting the
 * host to rate-limit you.
 */
class ScannerApi(private val baseUrl: String) {

    suspend fun status(): Status = withContext(Dispatchers.IO) {
        val json = get("/api/status")
        val lastSweep = json.optJSONObject("lastSweep")
        Status(
            itemCount = json.optInt("itemCount"),
            petCount = json.optInt("petCount"),
            feePct = json.optDouble("feePct", 0.25),
            breakEvenRatio = json.optDouble("breakEvenRatio", 5.333),
            maxNormalPrice = json.optDouble("maxNormalPrice", 3.0),
            stale = json.optBoolean("stale", true),
            lastSweepStatus = lastSweep?.optStringOrNull("status"),
            lastSweepItems = lastSweep?.optInt("itemsSeen") ?: 0,
            ageSeconds = json.optLongOrNull("staleSeconds"),
        )
    }

    suspend fun opportunities(
        maxNormalPrice: Double,
        feePctPercent: Double,
        verdict: String,
        sortBy: String,
        limit: Int = 200,
    ): List<Opportunity> = withContext(Dispatchers.IO) {
        val query = buildString {
            append("/api/opportunities?")
            append("maxNormalPrice=").append(maxNormalPrice)
            append("&feePct=").append(feePctPercent)
            append("&sort=").append(sortBy)
            append("&limit=").append(limit)
            if (verdict != "profitable") {
                append("&verdict=").append(verdict)
                append("&includeLosses=true")
            }
        }
        val json = get(query)
        val array = json.optJSONArray("opportunities") ?: JSONArray()
        (0 until array.length()).map { parseOpportunity(array.getJSONObject(it)) }
    }

    suspend fun pet(slug: String): PetDetail = withContext(Dispatchers.IO) {
        val json = get("/api/pets/${slug.urlEncoded()}")
        val ladder = json.optJSONArray("neonLadder") ?: JSONArray()
        val variants = json.optJSONArray("variants") ?: JSONArray()
        PetDetail(
            summary = parseOpportunity(json.getJSONObject("summary")),
            neonLadder = (0 until ladder.length()).map { index ->
                val rung = ladder.getJSONObject(index)
                NeonRung(
                    age = rung.optStringOrNull("age"),
                    price = rung.optDouble("price"),
                    productId = rung.optLong("productId"),
                )
            },
            variants = (0 until variants.length()).map { variants.getString(it) },
        )
    }

    /**
     * Live depth lookup. Unlike everything else in the app this reaches the
     * market through the backend, because a min price with one offer is not a
     * real opportunity when a craft consumes four units.
     */
    suspend fun orderBook(productId: Long, units: Int): OrderBook = withContext(Dispatchers.IO) {
        val json = get("/api/order-book?productId=$productId&units=$units")
        val offers = json.optJSONArray("offers") ?: JSONArray()
        OrderBook(
            productId = json.optLong("productId"),
            units = json.optInt("units", units),
            enough = json.optBoolean("enough"),
            available = json.optInt("available"),
            costForUnits = json.optDoubleOrNull("costForUnits"),
            cheapest = json.optDoubleOrNull("cheapest"),
            offers = (0 until offers.length()).map { index ->
                val offer = offers.getJSONObject(index)
                Offer(id = offer.optString("id"), price = offer.optDouble("price"))
            },
        )
    }

    private fun get(path: String): JSONObject {
        val url = URL(baseUrl.trimEnd('/') + path)
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 12_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
        }
        try {
            val code = connection.responseCode
            if (code !in 200..299) {
                val body = connection.errorStream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
                throw ScannerApiException(code, body.ifBlank { connection.responseMessage ?: "request failed" })
            }
            val body = connection.inputStream.bufferedReader().use(BufferedReader::readText)
            return JSONObject(body)
        } finally {
            connection.disconnect()
        }
    }
}

class ScannerApiException(val statusCode: Int, override val message: String) : Exception(message)

private fun String.urlEncoded(): String =
    java.net.URLEncoder.encode(this, Charsets.UTF_8.name()).replace("+", "%20")

/** org.json returns NaN for a missing number, and 0 for a missing object. */
private fun JSONObject.optDoubleOrNull(key: String): Double? {
    if (!has(key) || isNull(key)) return null
    val value = optDouble(key, Double.NaN)
    return if (value.isNaN() || value <= 0.0) null else value
}

private fun JSONObject.optLongOrNull(key: String): Long? {
    if (!has(key) || isNull(key)) return null
    return optLong(key)
}

private fun JSONObject.optStringOrNull(key: String): String? {
    if (!has(key) || isNull(key)) return null
    val value = optString(key)
    return value.ifBlank { null }
}

private fun parseOpportunity(json: JSONObject): Opportunity {
    val flags = json.optJSONArray("flags") ?: JSONArray()
    return Opportunity(
        petSlug = json.optString("petSlug"),
        petName = json.optString("petName"),
        rare = json.optStringOrNull("rare"),
        normalPrice = json.optDouble("normalPrice"),
        normalAge = json.optStringOrNull("normalAge"),
        normalProductId = json.optLong("normalProductId"),
        craftCost = json.optDouble("craftCost"),
        neonPrice = json.optDouble("neonPrice"),
        neonAge = json.optStringOrNull("neonAge"),
        neonProductId = json.optLong("neonProductId"),
        neonNet = json.optDouble("neonNet"),
        margin = json.optDouble("margin"),
        ratio = json.optDouble("ratio"),
        breakEvenRatio = json.optDouble("breakEvenRatio", 5.333),
        tierGap = json.optDouble("tierGap"),
        feePct = json.optDouble("feePct", 0.25),
        verdict = json.optString("verdict", "skip"),
        flags = (0 until flags.length()).map { flags.getString(it) },
        normalAvgPrice = json.optDoubleOrNull("normalAvgPrice"),
        neonAvgPrice = json.optDoubleOrNull("neonAvgPrice"),
    )
}
