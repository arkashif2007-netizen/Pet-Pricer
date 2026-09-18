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

const val DEFAULT_BASE_URL = "http://10.0.2.2:8787"

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

    private val _state = MutableStateFlow(
        ScannerUiState(
            baseUrl = prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL) ?: DEFAULT_BASE_URL,
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

    private companion object {
        const val KEY_BASE_URL = "base_url"
        const val KEY_FEE = "fee_pct"
        const val KEY_MAX_NORMAL = "max_normal_price"
        const val KEY_SORT = "sort_by"
    }
}
