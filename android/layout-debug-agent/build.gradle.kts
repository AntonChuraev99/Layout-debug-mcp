import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.SourcesJar
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.maven.publish)
}

android {
    namespace = "io.github.antonchuraev99.layoutdebug.agent"
    compileSdk = 36

    defaultConfig {
        minSdk = 21
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    explicitApi()
    // Readable by apps on older Kotlin compilers, and does not upgrade their kotlin-stdlib.
    coreLibrariesVersion = "2.2.0"
    compilerOptions {
        apiVersion.set(KotlinVersion.KOTLIN_2_2)
        languageVersion.set(KotlinVersion.KOTLIN_2_2)
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

mavenPublishing {
    configure(
        AndroidSingleVariantLibrary(
            javadocJar = JavadocJar.Empty(),
            sourcesJar = SourcesJar.Sources(),
            variant = "release",
        ),
    )
    publishToMavenCentral()
    // Central requires signed artifacts and rejects unsigned ones; publishToMavenLocal does not
    // need a key. The key comes only from Gradle properties / ORG_GRADLE_PROJECT_* env.
    if (providers.gradleProperty("signingInMemoryKey").isPresent || providers.gradleProperty("signing.keyId").isPresent) {
        signAllPublications()
    }
}
