package com.freebuff.starpets.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Profit = Color(0xFF2E7D32)
private val Loss = Color(0xFFC62828)
private val Warning = Color(0xFFEF6C00)

val ProfitColor: Color = Profit
val LossColor: Color = Loss
val WarningColor: Color = Warning

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF7FD1AE),
    secondary = Color(0xFF9EC7F3),
    background = Color(0xFF10151A),
    surface = Color(0xFF171D24),
    surfaceVariant = Color(0xFF212932),
)

private val LightScheme = lightColorScheme(
    primary = Color(0xFF1B6B4C),
    secondary = Color(0xFF2A5A8F),
    background = Color(0xFFF6F8FA),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFE7ECF1),
)

@Composable
fun ScannerTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkScheme else LightScheme,
        content = content,
    )
}
