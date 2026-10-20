import com.android.build.api.dsl.LibraryExtension
import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import com.vanniktech.maven.publish.JavadocJar
import com.vanniktech.maven.publish.MavenPublishBaseExtension
import com.vanniktech.maven.publish.SourcesJar
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.maven.publish) apply false
}

/**
 * What both published libraries share (layout-debug-agent, layout-debug-noop): SDK levels,
 * Kotlin compatibility and Maven Central publishing. A module opts in by applying the
 * com.vanniktech.maven.publish plugin after com.android.library.
 */
subprojects {
    plugins.withId("com.vanniktech.maven.publish") {
        extensions.configure<LibraryExtension> {
            compileSdk = 36
            defaultConfig.minSdk = 21
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_17
                targetCompatibility = JavaVersion.VERSION_17
            }
        }
        extensions.configure<KotlinAndroidProjectExtension> {
            explicitApi()
            // Readable by apps on older Kotlin compilers, and does not upgrade their kotlin-stdlib.
            coreLibrariesVersion = "2.2.0"
            compilerOptions {
                apiVersion.set(KotlinVersion.KOTLIN_2_2)
                languageVersion.set(KotlinVersion.KOTLIN_2_2)
            }
        }
        extensions.configure<MavenPublishBaseExtension> {
            configure(
                AndroidSingleVariantLibrary(
                    javadocJar = JavadocJar.Empty(),
                    sourcesJar = SourcesJar.Sources(),
                    variant = "release",
                ),
            )
            publishToMavenCentral()
            // Central requires signed artifacts and rejects unsigned ones; publishToMavenLocal does
            // not need a key. The key comes only from Gradle properties / ORG_GRADLE_PROJECT_* env.
            if (providers.gradleProperty("signingInMemoryKey").isPresent ||
                providers.gradleProperty("signing.keyId").isPresent
            ) {
                signAllPublications()
            }
        }
    }
}
