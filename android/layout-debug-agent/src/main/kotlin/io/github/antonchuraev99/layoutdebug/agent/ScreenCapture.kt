package io.github.antonchuraev99.layoutdebug.agent

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.PixelCopy
import android.view.View
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** A PNG of the content view, pixel-aligned with the boxes `/tree` reports, or why there is none. */
internal object ScreenCapture {

    sealed interface Shot {
        class Png(val bytes: ByteArray) : Shot
        class Failed(val reason: String) : Shot
    }

    private val copyThread by lazy { HandlerThread("layout-debug-pixelcopy").apply { start() } }

    fun screenshot(activity: Activity?): Shot {
        if (activity == null) return Shot.Failed("no resumed activity: bring the app to the foreground")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return Shot.Failed("screenshots need Android 8.0 (API 26) or newer, this device runs API ${Build.VERSION.SDK_INT}")
        }
        return copy(activity)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun copy(activity: Activity): Shot {
        val area = onMain {
            val view = activity.findViewById<View>(android.R.id.content)
            if (view == null || view.width <= 0 || view.height <= 0) {
                null
            } else {
                val location = IntArray(2).also(view::getLocationInWindow)
                Rect(location[0], location[1], location[0] + view.width, location[1] + view.height)
            }
        }.getOrElse { return Shot.Failed("could not measure the content view: ${it.message}") }
            ?: return Shot.Failed("the content view is not laid out yet")

        val bitmap = Bitmap.createBitmap(area.width(), area.height(), Bitmap.Config.ARGB_8888)
        val latch = CountDownLatch(1)
        var status = -1
        val requested = runCatching {
            PixelCopy.request(activity.window, area, bitmap, { result ->
                status = result
                latch.countDown()
            }, Handler(copyThread.looper))
        }
        requested.exceptionOrNull()?.let {
            bitmap.recycle()
            return Shot.Failed("PixelCopy failed: ${it.message}")
        }
        if (!latch.await(MAIN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            return Shot.Failed("PixelCopy did not answer within $MAIN_TIMEOUT_SECONDS s")
        }
        if (status != PixelCopy.SUCCESS) {
            bitmap.recycle()
            return Shot.Failed("PixelCopy returned error $status (the window may not be drawn yet)")
        }
        val png = ByteArrayOutputStream().use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
            stream.toByteArray()
        }
        bitmap.recycle()
        return Shot.Png(png)
    }
}
