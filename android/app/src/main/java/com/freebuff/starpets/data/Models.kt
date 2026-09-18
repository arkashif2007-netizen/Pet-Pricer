package com.freebuff.starpets.data

/**
 * Data models mirroring the scanner's JSON API.
 *
 * The single most important invariant carried through this layer: a price of
 * `0` from the market means "no data", not "free". The server already filters
 * those out before sending anything, and these models keep the distinction by
 * using nullable doubles for anything that can legitimately be absent.
 */

data class Status(
    val itemCount: Int,
    val petCount: Int,
    val feePct: Double,
    val breakEvenRatio: Double,
    val maxNormalPrice: Double,
    val stale: Boolean,
    val lastSweepStatus: String?,
    val lastSweepItems: Int,
    val ageSeconds: Long?,
) {
    /** A four-minute floor is imposed by the market's own CDN cache. */
    val freshnessLabel: String
        get() = when {
            ageSeconds == null -> "never swept"
            ageSeconds < 90 -> "fresh"
            ageSeconds < 900 -> "${ageSeconds / 60}m old"
            else -> "stale (${ageSeconds / 60}m) — collect or refresh"
        }
}

data class Opportunity(
    val petSlug: String,
    val petName: String,
    val rare: String?,
    val normalPrice: Double,
    val normalAge: String?,
    val normalProductId: Long,
    val craftCost: Double,
    val neonPrice: Double,
    val neonAge: String?,
    val neonProductId: Long,
    val neonNet: Double,
    val margin: Double,
    val ratio: Double,
    val breakEvenRatio: Double,
    val tierGap: Double,
    val feePct: Double,
    val verdict: String,
    val flags: List<String>,
    val normalAvgPrice: Double?,
    val neonAvgPrice: Double?,
) {
    val profitable: Boolean get() = margin > 0

    /** How far above the break-even ratio this pet trades. 1.0 is exactly break-even. */
    val headroom: Double get() = if (breakEvenRatio > 0) ratio / breakEvenRatio else 0.0

    /** Cheapest input relative to its own 7-day average, as a fraction below it. */
    val discount: Double?
        get() = normalAvgPrice?.takeIf { it > 0 }?.let { (it - normalPrice) / it }
}

data class NeonRung(val age: String?, val price: Double, val productId: Long)

data class Offer(val id: String, val price: Double)

data class OrderBook(
    val productId: Long,
    val units: Int,
    val enough: Boolean,
    val available: Int,
    val costForUnits: Double?,
    val cheapest: Double?,
    val offers: List<Offer>,
)

data class PetDetail(
    val summary: Opportunity,
    val neonLadder: List<NeonRung>,
    val variants: List<String>,
)
