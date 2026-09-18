package com.freebuff.starpets

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationCompat
import java.util.Locale

class AndroidBridge(private val context: Context) {

    private val notificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    init {
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Pet Pricer Alerts & Opportunities",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Notifies you in real-time when profitable Adopt Me crafts or price target alerts occur."
                enableVibration(true)
            }
            notificationManager.createNotificationChannel(channel)
        }
    }

    @JavascriptInterface
    fun postNotification(title: String, message: String, slug: String?) {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("slug", slug)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            System.currentTimeMillis().toInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()

        notificationManager.notify((System.currentTimeMillis() % 100000).toInt(), notification)
    }

    @JavascriptInterface
    fun onOpportunitiesEvaluated(count: Int, topPetName: String, topMargin: Double, slug: String?) {
        if (topMargin > 0.05) {
            val title = "💎 $count Profitable Adopt Me Crafts Found!"
            val message = "$topPetName gives +$${String.format(Locale.US, "%.2f", topMargin)} profit after 25% StarPets fee!"
            postNotification(title, message, slug)
        }
    }

    @JavascriptInterface
    fun vibrate(milliseconds: Long) {
        try {
            val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            if (vibrator != null && vibrator.hasVibrator()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createOneShot(milliseconds, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator.vibrate(milliseconds)
                }
            }
        } catch (e: Exception) {}
    }

    companion object {
        const val CHANNEL_ID = "pet_pricer_alerts"
    }
}
