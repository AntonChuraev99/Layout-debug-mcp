import com.android.build.api.artifact.SingleArtifact

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.example.layoutdebug.sample"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.example.layoutdebug.sample"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        manifestPlaceholders["layoutDebugPort"] = providers.gradleProperty("layoutDebugPort").getOrElse("8790")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["layoutDebugPort"] = providers.gradleProperty("layoutDebugPort").getOrElse("8790")
        // The compatibility matrix (CI) passes the Compose UI version it expects at runtime, so a
        // dependency that pulls a newer Compose in cannot make a row test the wrong version.
        providers.gradleProperty("expectedComposeUi").orNull?.let {
            testInstrumentationRunnerArguments["expectedComposeUi"] = it
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // A sample: signed with the debug key so the release APK installs for a check.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }
}

dependencies {
    // -PcomposeBom=<version> and -PactivityCompose=<version> build the sample against another
    // Compose line: the compatibility matrix in .github/workflows/ci.yml and the README table.
    val composeBom = providers.gradleProperty("composeBom").orNull
    val activityCompose = providers.gradleProperty("activityCompose").orNull
    if (composeBom != null) implementation(platform("androidx.compose:compose-bom:$composeBom")) else implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    if (activityCompose != null) implementation("androidx.activity:activity-compose:$activityCompose") else implementation(libs.activity.compose)

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)

    // The two lines an app adds (from Maven Central: "io.github.antonchuraev99:layout-debug-agent:0.1.0").
    debugImplementation(project(":layout-debug-agent"))
    releaseImplementation(project(":layout-debug-noop"))
}

/**
 * Fails when a release build carries agent code: any class of the agent's package or of
 * ui-tooling-data in the R8 mapping (it lists every class left in the APK), or the agent's
 * startup entry in the merged manifest. CI runs it after assembleRelease.
 */
abstract class VerifyNoAgentTask : DefaultTask() {
    @get:InputFile
    abstract val mappingFile: RegularFileProperty

    @get:InputFile
    abstract val mergedManifest: RegularFileProperty

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun verify() {
        val forbidden = listOf("io.github.antonchuraev99.layoutdebug.agent.", "androidx.compose.ui.tooling.data.")
        val classes = mappingFile.get().asFile.readLines()
            .filter { it.isNotEmpty() && !it.startsWith(" ") && !it.startsWith("#") && it.contains(" -> ") }
            .map { it.substringBefore(" -> ") }
        val leaked = classes.filter { name -> forbidden.any { name.startsWith(it) } }
        val manifest = mergedManifest.get().asFile.readText()
        val manifestLeaks = listOf("LayoutDebugInitializer", "android.permission.INTERNET").filter { manifest.contains(it) }
        val text = buildString {
            appendLine("classes in the release APK: ${classes.size}")
            appendLine("agent classes: ${leaked.size}")
            leaked.forEach { appendLine("  $it") }
            appendLine("agent entries in the merged manifest: ${manifestLeaks.size}")
            manifestLeaks.forEach { appendLine("  $it") }
        }
        report.get().asFile.writeText(text)
        logger.lifecycle(text)
        if (leaked.isNotEmpty() || manifestLeaks.isNotEmpty()) {
            throw GradleException("The release build carries layout-debug agent code:\n$text")
        }
    }
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        tasks.register<VerifyNoAgentTask>("verify${name}HasNoAgent") {
            group = "verification"
            description = "Checks that the $name APK contains no layout-debug agent code."
            mappingFile.set(variant.artifacts.get(SingleArtifact.OBFUSCATION_MAPPING_FILE))
            mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            report.set(layout.buildDirectory.file("reports/no-agent/${variant.name}.txt"))
        }
    }
}
