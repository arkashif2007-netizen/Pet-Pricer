package com.freebuff.starpets.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.freebuff.starpets.data.Opportunity
import com.freebuff.starpets.data.PetDetail
import java.util.Locale
import kotlin.math.roundToInt

private fun money(value: Double, decimals: Int = 2): String =
    String.format(Locale.US, "$%.${decimals}f", value)

private fun signedMoney(value: Double): String =
    (if (value >= 0) "+" else "-") + money(kotlin.math.abs(value), 3)

@Composable
fun ScannerApp(viewModel: ScannerViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    ScannerTheme {
        ScannerScreen(
            state = state,
            onRefresh = { viewModel.refresh() },
            onVerdict = viewModel::setVerdictFilter,
            onSort = viewModel::setSort,
            onMaxNormalPrice = viewModel::setMaxNormalPrice,
            onFee = viewModel::setFeePercent,
            onBaseUrl = viewModel::setBaseUrl,
            onToggleSettings = viewModel::setShowSettings,
            onSelect = viewModel::selectPet,
            onBack = viewModel::clearSelection,
            onDepth = viewModel::loadOrderBook,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScannerScreen(
    state: ScannerUiState,
    onRefresh: () -> Unit,
    onVerdict: (String) -> Unit,
    onSort: (String) -> Unit,
    onMaxNormalPrice: (Double) -> Unit,
    onFee: (Double) -> Unit,
    onBaseUrl: (String) -> Unit,
    onToggleSettings: (Boolean) -> Unit,
    onSelect: (String) -> Unit,
    onBack: () -> Unit,
    onDepth: (Long, Int) -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(state.selected?.summary?.petName ?: "Margin Scanner") },
                navigationIcon = {
                    if (state.selected != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { onToggleSettings(!state.showSettings) }) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        }
    ) { padding ->
        Column(modifier = Modifier.padding(padding).fillMaxSize()) {
            if (state.loading && state.opportunities.isEmpty()) {
                LoadingPane()
                return@Column
            }

            if (state.showSettings) {
                SettingsPanel(
                    state = state,
                    onBaseUrl = onBaseUrl,
                    onFee = onFee,
                    onMaxNormalPrice = onMaxNormalPrice,
                )
            }

            state.status?.let { status -> StatusHeader(status, state) }

            state.error?.let { error ->
                ErrorBanner(error)
            }

            if (state.selected != null) {
                PetDetailView(
                    detail = state.selected,
                    orderBook = state.orderBook,
                    onDepth = onDepth,
                )
            } else {
                FilterRow(
                    verdictFilter = state.verdictFilter,
                    sortBy = state.sortBy,
                    onVerdict = onVerdict,
                    onSort = onSort,
                )
                OpportunityList(state.opportunities, onSelect)
            }
        }
    }
}

@Composable
private fun LoadingPane() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun StatusHeader(status: com.freebuff.starpets.data.Status, state: ScannerUiState) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("${status.petCount} pets · ${status.itemCount} priced items", fontWeight = FontWeight.SemiBold)
                Text(
                    status.freshnessLabel,
                    color = if (status.stale) WarningColor else ProfitColor,
                    fontSize = 12.sp,
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                "Break-even ratio ${String.format(Locale.US, "%.2f", status.breakEvenRatio)}x · " +
                    "fee ${status.feePct.times(100).roundToInt()}% · " +
                    "cap ${money(status.maxNormalPrice)}",
                fontSize = 12.sp,
            )
            Text(
                "A neon must be worth more than ${String.format(Locale.US, "%.2f", status.breakEvenRatio)}x " +
                    "the normal pet, or crafting is a guaranteed loss.",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ErrorBanner(message: String) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = LossColor.copy(alpha = 0.15f)),
    ) {
        Text(
            message,
            modifier = Modifier.padding(12.dp),
            color = LossColor,
            fontSize = 13.sp,
        )
    }
}

@Composable
private fun SettingsPanel(
    state: ScannerUiState,
    onBaseUrl: (String) -> Unit,
    onFee: (Double) -> Unit,
    onMaxNormalPrice: (Double) -> Unit,
) {
    var urlDraft by remember(state.baseUrl) { mutableStateOf(state.baseUrl) }

    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text("Backend", fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = urlDraft,
                onValueChange = { urlDraft = it },
                label = { Text("Scanner URL") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            Row {
                TextButton(onClick = { onBaseUrl(urlDraft) }) { Text("Apply") }
                Spacer(Modifier.width(8.dp))
                TextButton(onClick = { urlDraft = DEFAULT_BASE_URL }) { Text("Emulator default") }
            }

            HorizontalDivider(Modifier.padding(vertical = 8.dp))

            Text("Sell fee: ${state.feePctPercent.roundToInt()}%", fontWeight = FontWeight.SemiBold)
            Text(
                "Break-even ${String.format(Locale.US, "%.2f", 4 / (1 - state.feePctPercent / 100))}x",
                fontSize = 11.sp,
            )
            Slider(
                value = state.feePctPercent.toFloat(),
                onValueChange = { onFee(it.toDouble()) },
                valueRange = 0f..60f,
                steps = 59,
            )

            Text("Capital cap: ${money(state.maxNormalPrice)}", fontWeight = FontWeight.SemiBold)
            Slider(
                value = state.maxNormalPrice.toFloat(),
                onValueChange = { onMaxNormalPrice(it.toDouble()) },
                valueRange = 0.1f..20f,
            )
        }
    }
}

@Composable
private fun FilterRow(
    verdictFilter: String,
    sortBy: String,
    onVerdict: (String) -> Unit,
    onSort: (String) -> Unit,
) {
    Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("profitable" to "Profitable", "craft" to "Craft", "marginal" to "Marginal", "all" to "All")
                .forEach { (key, label) ->
                    FilterChip(
                        selected = verdictFilter == key,
                        onClick = { onVerdict(key) },
                        label = { Text(label, fontSize = 12.sp) },
                    )
                }
        }
        Spacer(Modifier.height(4.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            listOf("ratio" to "Ratio", "margin" to "Margin", "discount" to "Dip")
                .forEach { (key, label) ->
                    FilterChip(
                        selected = sortBy == key,
                        onClick = { onSort(key) },
                        label = { Text(label, fontSize = 12.sp) },
                    )
                }
        }
    }
}

@Composable
private fun OpportunityList(opportunities: List<Opportunity>, onSelect: (String) -> Unit) {
    if (opportunities.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text(
                "Nothing clears the fee right now.\nThat is the normal state — most pets lose money.",
                fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(opportunities, key = { it.petSlug }) { opportunity ->
            OpportunityCard(opportunity, onClick = { onSelect(opportunity.petSlug) })
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OpportunityCard(opportunity: Opportunity, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        onClick = onClick,
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(opportunity.petName, fontWeight = FontWeight.SemiBold)
                    Text(
                        opportunity.rare?.replace('_', ' ') ?: "",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    signedMoney(opportunity.margin),
                    color = if (opportunity.profitable) ProfitColor else LossColor,
                    fontWeight = FontWeight.Bold,
                )
            }

            Spacer(Modifier.height(6.dp))

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                LabeledValue("4 × normal", money(opportunity.normalPrice))
                LabeledValue("craft cost", money(opportunity.craftCost))
                LabeledValue("neon", money(opportunity.neonPrice))
                LabeledValue("neon net", money(opportunity.neonNet))
            }

            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                VerdictBadge(opportunity.verdict)
                Spacer(Modifier.width(8.dp))
                Text(
                    "${String.format(Locale.US, "%.2f", opportunity.ratio)}x vs " +
                        "${String.format(Locale.US, "%.2f", opportunity.breakEvenRatio)}x break-even",
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            val notes = opportunity.flags.toDisplayNotes()
            if (notes.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(notes, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * Flags are rendered as prose because the whole point of the app is to explain
 * *why* a number is what it is, not just to print it.
 */
private fun List<String>.toDisplayNotes(): String = mapNotNull {
    when (it) {
        "fee_erases_margin" -> "the fee erases the gross spread"
        "below_break_even_ratio" -> "under the break-even ratio"
        "ageing_unpaid" -> "ageing adds almost nothing"
        "full_grown_cheaper_than_newborn" -> "full-grown asks less than newborn"
        "no_data_zero_price" -> "a rung reported no price"
        "outlier_ask_rejected" -> "an implausible ask was ignored"
        "thin_depth" -> "thin margin on capital"
        "low_liquidity" -> "low turnover"
        else -> null
    }
}.distinct().joinToString(" · ")

@Composable
private fun VerdictBadge(verdict: String) {
    val (color, label) = when (verdict) {
        "craft" -> ProfitColor to "CRAFT"
        "marginal" -> WarningColor to "MARGINAL"
        else -> LossColor to "SKIP"
    }
    Box(
        Modifier
            .background(color.copy(alpha = 0.18f), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp)
    ) {
        Text(label, color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun LabeledValue(label: String, value: String) {
    Column {
        Text(label, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun PetDetailView(
    detail: PetDetail,
    orderBook: com.freebuff.starpets.data.OrderBook?,
    onDepth: (Long, Int) -> Unit,
) {
    val summary = detail.summary
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(12.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            VerdictBadge(summary.verdict)
            Spacer(Modifier.width(8.dp))
            Text(
                if (summary.profitable) "Profit ${signedMoney(summary.margin)} per craft"
                else "Loss ${signedMoney(summary.margin)} per craft",
                fontWeight = FontWeight.SemiBold,
                color = if (summary.profitable) ProfitColor else LossColor,
            )
        }

        Spacer(Modifier.height(10.dp))

        DetailRow("Cheapest normal", "${money(summary.normalPrice)} · ${summary.normalAge ?: "n/a"}")
        DetailRow("Cost to craft", "4 × ${money(summary.normalPrice)} = ${money(summary.craftCost)}")
        DetailRow("Cheapest neon", "${money(summary.neonPrice)} · ${summary.neonAge ?: "n/a"}")
        DetailRow("Neon after fee", money(summary.neonNet))
        DetailRow(
            "Ratio",
            "${String.format(Locale.US, "%.2f", summary.ratio)}x   " +
                "(break-even ${String.format(Locale.US, "%.2f", summary.breakEvenRatio)}x)"
        )
        DetailRow("Age-ladder gap", money(summary.tierGap, 3))
        summary.discount?.let {
            DetailRow("Normal vs 7-day avg", "${String.format(Locale.US, "%.1f", it * 100)}% below")
        }

        Spacer(Modifier.height(14.dp))
        Text("Neon rungs walked", fontWeight = FontWeight.SemiBold)
        Text(
            "Every age is checked, cheapest first — the ladder is not ordered.",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(6.dp))
        detail.neonLadder.forEach { rung ->
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(rung.age ?: "—", fontSize = 13.sp)
                Text(
                    money(rung.price),
                    fontSize = 13.sp,
                    color = if (rung.productId == summary.neonProductId) ProfitColor else Color.Unspecified,
                    fontWeight = if (rung.productId == summary.neonProductId) FontWeight.Bold else FontWeight.Normal,
                )
            }
        }

        Spacer(Modifier.height(14.dp))
        Text("Depth check", fontWeight = FontWeight.SemiBold)
        Text(
            "A craft consumes 4 units. A single cheap listing is not an opportunity.",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(6.dp))
        Button(onClick = { onDepth(summary.normalProductId, 4) }) { Text("Check 4-unit depth (live)") }

        orderBook?.let { book ->
            Spacer(Modifier.height(8.dp))
            Text(
                if (book.enough) "Depth OK: ${book.available} offers, 4 units cost ${money(book.costForUnits ?: 0.0)}"
                else "NOT enough depth: only ${book.available} offer(s) for ${book.units} units",
                color = if (book.enough) ProfitColor else LossColor,
                fontSize = 13.sp,
            )
        }

        Spacer(Modifier.height(14.dp))
        Text("Variants seen", fontWeight = FontWeight.SemiBold)
        Text(detail.variants.joinToString("\n"), fontSize = 12.sp)

        Spacer(Modifier.height(20.dp))
    }
}

@Composable
private fun DetailRow(label: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 3.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}
