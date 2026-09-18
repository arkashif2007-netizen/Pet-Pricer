package com.freebuff.starpets.ui

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.freebuff.starpets.data.Opportunity
import com.freebuff.starpets.data.OrderBook
import com.freebuff.starpets.data.PetDetail
import com.freebuff.starpets.data.ScannerApi
import com.freebuff.starpets.data.Status
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.freebuff.starpets.MainActivity
import com.freebuff.starpets.R
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Refresh cadence. The market serves the data this backend reads from a
 * 4-minute CDN cache, so nothing faster can produce new information — "real
 * time" on this data has a hard floor of about 240 seconds.
 */
private const val REFRESH_INTERVAL_MS = 4 * 60 * 1000L

const val DEFAULT_BASE_URL = "https://pet-pricer.vercel.app"

data class ScannerUiState(
    val loading: Boolean = false,
    val status: Status? = null,
    val opportunities: List<Opportunity> = emptyList(),
    val error: String? = null,
    val verdictFilter: String = "profitable",
    val sortBy: String = "ratio",
    val maxNormalPrice: Double = 3.0,
    val feePctPercent: Double = 25.0,
    val baseUrl: String = DEFAULT_BASE_URL,
    val selected: PetDetail? = null,
    val selectedLoading: Boolean = false,
    val orderBook: OrderBook? = null,
    val lastRefreshedAt: Long? = null,
    val showSettings: Boolean = false,
)

class ScannerViewModel(application: Application) : AndroidViewModel(application) {

    private val prefs = application.getSharedPreferences("scanner", Context.MODE_PRIVATE)

    private fun resolveInitialUrl(): String {
        val saved = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL
        return if (saved.contains("192.168") || saved.contains("10.0.2.2") || saved.contains(":8787")) {
            prefs.edit().putString(KEY_BASE_URL, DEFAULT_BASE_URL).apply()
            DEFAULT_BASE_URL
        } else {
            saved
        }
    }

    private val _state = MutableStateFlow(
        ScannerUiState(
            baseUrl = resolveInitialUrl(),
            feePctPercent = prefs.getFloat(KEY_FEE, 25f).toDouble(),
            maxNormalPrice = prefs.getFloat(KEY_MAX_NORMAL, 3f).toDouble(),
            sortBy = prefs.getString(KEY_SORT, "ratio") ?: "ratio",
        )
    )
    val state: StateFlow<ScannerUiState> = _state.asStateFlow()

    private var pollJob: Job? = null

    init {
        refresh()
        pollJob = viewModelScope.launch {
            while (true) {
                delay(REFRESH_INTERVAL_MS)
                refresh(showSpinner = false)
            }
        }
    }

    /** Reload the snapshot from the backend. */
    fun refresh(showSpinner: Boolean = true) {
        viewModelScope.launch {
            val current = _state.value
            if (showSpinner) _state.update { it.copy(loading = true, error = null) }
            val api = ScannerApi(current.baseUrl)
            try {
                val status = api.status()
                val opportunities = api.opportunities(
                    maxNormalPrice = current.maxNormalPrice,
                    feePctPercent = current.feePctPercent,
                    verdict = current.verdictFilter,
                    sortBy = current.sortBy,
                )
                _state.update {
                    it.copy(
                        loading = false,
                        status = status,
                        opportunities = opportunities,
                        error = null,
                        lastRefreshedAt = System.currentTimeMillis(),
                    )
                }
                val topCraft = opportunities.firstOrNull { it.verdict == "craft" && (it.margin ?: 0.0) > 0.0 }
                if (topCraft != null) {
                    sendNotification(topCraft)
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        loading = false,
                        error = e.message ?: "Could not reach ${current.baseUrl}",
                    )
                }
            }
        }
    }

    fun setVerdictFilter(verdict: String) {
        _state.update { it.copy(verdictFilter = verdict) }
        refresh(showSpinner = false)
    }

    fun setSort(sort: String) {
        _state.update { it.copy(sortBy = sort) }
        refresh(showSpinner = false)
    }

    fun setMaxNormalPrice(value: Double) {
        prefs.edit().putFloat(KEY_MAX_NORMAL, value.toFloat()).apply()
        _state.update { it.copy(maxNormalPrice = value) }
        refresh(showSpinner = false)
    }

    fun setFeePercent(value: Double) {
        prefs.edit().putFloat(KEY_FEE, value.toFloat()).apply()
        _state.update { it.copy(feePctPercent = value) }
        refresh(showSpinner = false)
    }

    fun setBaseUrl(value: String) {
        val trimmed = value.trim().trimEnd('/')
        if (trimmed.isEmpty()) return
        prefs.edit().putString(KEY_BASE_URL, trimmed).apply()
        _state.update { it.copy(baseUrl = trimmed) }
        refresh()
    }

    fun setShowSettings(show: Boolean) {
        _state.update { it.copy(showSettings = show) }
    }

    /** Open the full breakdown for one pet, including its neon age ladder. */
    fun selectPet(slug: String) {
        viewModelScope.launch {
            _state.update { it.copy(selectedLoading = true, orderBook = null) }
            try {
                val detail = ScannerApi(_state.value.baseUrl).pet(slug)
                _state.update { it.copy(selected = detail, selectedLoading = false) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(selectedLoading = false, error = e.message ?: "Could not load $slug")
                }
            }
        }
    }

    fun clearSelection() {
        _state.update { it.copy(selected = null, orderBook = null) }
    }

    /** Ask the backend for live order-book depth on one product. */
    fun loadOrderBook(productId: Long, units: Int = 4) {
        viewModelScope.launch {
            try {
                val book = ScannerApi(_state.value.baseUrl).orderBook(productId, units)
                _state.update { it.copy(orderBook = book) }
            } catch (e: Exception) {
                _state.update { it.copy(error = e.message ?: "Depth lookup failed") }
            }
        }
    }

    fun dismissError() {
        _state.update { it.copy(error = null) }
    }

    override fun onCleared() {
        pollJob?.cancel()
        super.onCleared()
    }

    private fun sendNotification(opp: Opportunity) {
        try {
            val context = getApplication<Application>().applicationContext
            val channelId = "pet_pricer_alerts"
            val notificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(
                    channelId,
                    "Pet Pricer Margin Alerts",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Alerts when profitable pet crafts are found on StarPets"
                }
                notificationManager.createNotificationChannel(channel)
            }

            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            val pendingIntent = PendingIntent.getActivity(
                context, 0, intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )

            val profitText = String.format(Locale.US, "$%.2f", opp.margin ?: 0.0)
            val notification = NotificationCompat.Builder(context, channelId)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("💎 Profitable Craft: ${opp.petName}")
                .setContentText("Net profit: $profitText per craft | Return: ${String.format(Locale.US, "%.1f", opp.ratio ?: 0.0)}x")
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .build()

            notificationManager.notify(opp.petSlug.hashCode(), notification)
        } catch (_: Exception) {
            // Notifications are best-effort
        }
    }

    private companion object {
        const val KEY_BASE_URL = "base_url"
        const val KEY_FEE = "fee_pct"
        const val KEY_MAX_NORMAL = "max_normal_price"
        const val KEY_SORT = "sort_by"
    }
}
