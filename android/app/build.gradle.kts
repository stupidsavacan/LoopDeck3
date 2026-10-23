import java.util.Properties
import org.gradle.api.GradleException

plugins {
    id("com.android.application")
}

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

val releaseSigningKeys = mapOf(
    "storeFile" to "LOOPDECK_KEYSTORE_FILE",
    "storePassword" to "LOOPDECK_KEYSTORE_PASSWORD",
    "keyAlias" to "LOOPDECK_KEY_ALIAS",
    "keyPassword" to "LOOPDECK_KEY_PASSWORD"
)
val releaseSigningValues = releaseSigningKeys.mapValues { (key, environment) ->
    providers.environmentVariable(environment).orNull ?: keystoreProperties.getProperty(key)
}
val hasReleaseSigning = releaseSigningValues.values.all { !it.isNullOrBlank() }

fun releaseSigningProperty(key: String): String = releaseSigningValues[key]
    ?: throw GradleException("Missing $key in android/keystore.properties for signed release builds.")

android {
    namespace = "com.loopdeck3.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.loopdeck3.app"
        minSdk = 23
        targetSdk = 35
        versionCode = providers.gradleProperty("appVersionCode").orElse("3001").get().toInt()
        versionName = providers.gradleProperty("appVersionName").orElse("0.3.1").get()
        resValue("string", "app_name", "LoopDeck3")
        testInstrumentationRunner = "com.loopdeck3.app.ReleaseSmokeInstrumentation"
        val syncOrigin = providers.gradleProperty("syncApiOrigin").orElse("").get()
        check(syncOrigin.isEmpty() || syncOrigin.matches(Regex("https://[a-z0-9-]+\\.[a-z0-9-]+\\.chatgpt\\.site"))) { "syncApiOrigin must be an approved Sites HTTPS origin" }
        buildConfigField("String", "SYNC_API_ORIGIN", "\"$syncOrigin\"")
    }

    buildFeatures {
        buildConfig = true
    }
    testBuildType = if (providers.gradleProperty("releaseQa").orElse("false").get() == "true") "release" else "debug"

    signingConfigs {
        create("release") {
            if (hasReleaseSigning) {
                storeFile = file(releaseSigningProperty("storeFile"))
                storePassword = releaseSigningProperty("storePassword")
                keyAlias = releaseSigningProperty("keyAlias")
                keyPassword = releaseSigningProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = if (providers.gradleProperty("syncPreview").orElse("false").get() == "true") ".syncpreview.debug" else ".debug"
            resValue("string", "app_name", if (providers.gradleProperty("syncPreview").orElse("false").get() == "true") "LoopDeck3 Sync Preview" else "LoopDeck3")
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
            if (providers.gradleProperty("syncPreview").orElse("false").get() == "true") {
                applicationIdSuffix = ".syncpreview.release"
                versionNameSuffix = "-syncqa"
                resValue("string", "app_name", "LoopDeck3 Sync Preview Release QA")
            }
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

tasks.matching { task -> task.name == "assembleRelease" || task.name == "bundleRelease" }.configureEach {
    doFirst {
        if (!hasReleaseSigning) {
            throw GradleException(
                "Signed release builds require android/keystore.properties or LOOPDECK_KEYSTORE_FILE, LOOPDECK_KEYSTORE_PASSWORD, LOOPDECK_KEY_ALIAS, LOOPDECK_KEY_PASSWORD environment variables. " +
                    "Debug builds do not need signing secrets."
            )
        }
    }
}

tasks.register<Sync>("syncLoopDeckDist") {
    val html = rootProject.file("../LoopDeck3.html")
    from(html) { rename { "index.html" } }
    into(layout.projectDirectory.dir("src/main/assets/loopdeck"))
    doFirst { check(html.isFile) { "Run npm run build:single before building the APK." } }
}

tasks.named("preBuild") {
    dependsOn("syncLoopDeckDist")
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime:2.10.1")
}
