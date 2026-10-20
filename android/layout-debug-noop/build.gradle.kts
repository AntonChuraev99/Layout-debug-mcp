plugins {
    alias(libs.plugins.android.library)
    // Publishing, SDK levels and Kotlin settings: the shared block in android/build.gradle.kts.
    alias(libs.plugins.maven.publish)
}

android {
    namespace = "io.github.antonchuraev99.layoutdebug.noop"
}
