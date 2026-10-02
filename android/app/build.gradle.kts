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

val releaseSigningKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
val hasReleaseSigning = keystorePropertiesFile.exists() && releaseSigningKeys.all { key ->
    !keystoreProperties.getProperty(key).isNullOrBlank()
}

fun releaseSigningProperty(key: String): String = keystoreProperties.getProperty(key)
    ?: throw GradleException("Missing $key in android/keystore.properties for signed release builds.")

android {
    namespace = "com.loopdeck3.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.loopdeck3.app"
        minSdk = 23
        targetSdk = 35
        versionCode = providers.gradleProperty("appVersionCode").orElse("1").get().toInt()
        versionName = providers.gradleProperty("appVersionName").orElse("0.1.0").get()
    }

    buildFeatures {
        buildConfig = true
    }

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
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = false
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
                "Signed release builds require android/keystore.properties with storeFile, storePassword, keyAlias, and keyPassword. " +
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

dependencies { implementation("androidx.webkit:webkit:1.12.1") }
