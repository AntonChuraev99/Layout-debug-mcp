package io.github.antonchuraev99.layoutdebug.agent

import kotlin.math.absoluteValue

/**
 * Tells a call in a Compose library from a call in the app's code.
 *
 * The Compose compiler writes a hash of the file's package into the source information of
 * every composable (`…:Text.kt#2iw4hb`), and ui-tooling exposes it as
 * `SourceLocation.packageHash`. A hash of one of the packages below is library code; any
 * other hash is the app's (or a third-party library's, which reads as the app's: harmless,
 * it only decides which name a collapsed chain shows). The same signal Android Studio's
 * Layout Inspector uses to hide system composables.
 */
internal object ComposePackages {

    /** The compiler's package hash: Java-style string hash, made non-negative. */
    fun hash(packageName: String): Int =
        packageName.fold(0) { hash, char -> hash * 31 + char.code }.absoluteValue

    private val packages = listOf(
        "androidx.compose.animation",
        "androidx.compose.animation.core",
        "androidx.compose.animation.graphics.vector",
        "androidx.compose.foundation",
        "androidx.compose.foundation.contextmenu",
        "androidx.compose.foundation.gestures",
        "androidx.compose.foundation.gestures.snapping",
        "androidx.compose.foundation.interaction",
        "androidx.compose.foundation.layout",
        "androidx.compose.foundation.lazy",
        "androidx.compose.foundation.lazy.grid",
        "androidx.compose.foundation.lazy.layout",
        "androidx.compose.foundation.lazy.staggeredgrid",
        "androidx.compose.foundation.pager",
        "androidx.compose.foundation.text",
        "androidx.compose.foundation.text.input",
        "androidx.compose.foundation.text.input.internal",
        "androidx.compose.foundation.text.selection",
        "androidx.compose.material",
        "androidx.compose.material.internal",
        "androidx.compose.material.navigation",
        "androidx.compose.material.pullrefresh",
        "androidx.compose.material.ripple",
        "androidx.compose.material3",
        "androidx.compose.material3.adaptive",
        "androidx.compose.material3.adaptive.layout",
        "androidx.compose.material3.adaptive.navigation",
        "androidx.compose.material3.adaptive.navigationsuite",
        "androidx.compose.material3.carousel",
        "androidx.compose.material3.internal",
        "androidx.compose.material3.pulltorefresh",
        "androidx.compose.runtime",
        "androidx.compose.runtime.internal",
        "androidx.compose.runtime.livedata",
        "androidx.compose.runtime.retain",
        "androidx.compose.runtime.saveable",
        "androidx.compose.ui",
        "androidx.compose.ui.graphics",
        "androidx.compose.ui.graphics.vector",
        "androidx.compose.ui.layout",
        "androidx.compose.ui.platform",
        "androidx.compose.ui.text",
        "androidx.compose.ui.viewinterop",
        "androidx.compose.ui.window",
        "androidx.activity.compose",
        "androidx.lifecycle.compose",
        "androidx.navigation.compose",
        "androidx.navigation3.runtime",
        "androidx.navigation3.scene",
        "androidx.navigation3.ui",
        "org.jetbrains.compose.resources",
    )

    private val hashes: Set<Int> = packages.mapTo(HashSet(), ::hash)

    fun isLibrary(packageHash: Int): Boolean = packageHash == -1 || packageHash in hashes
}
