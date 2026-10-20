plugins {
    alias(libs.plugins.android.library)
    // Publishing, SDK levels and Kotlin settings: the shared block in android/build.gradle.kts.
    alias(libs.plugins.maven.publish)
}

android {
    namespace = "io.github.antonchuraev99.layoutdebug.agent"

    defaultConfig {
        consumerProguardFiles("consumer-rules.pro")
        // /health reports it; one source of truth with the published version.
        buildConfigField("String", "AGENT_VERSION", "\"${providers.gradleProperty("VERSION_NAME").get()}\"")
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    // The floor, not the app's version: see composeBomFloor in libs.versions.toml.
    implementation(platform(libs.compose.bom.floor))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.data)
    implementation(libs.compose.foundation.layout)
    implementation(libs.startup.runtime)

    testImplementation(libs.junit)
}
