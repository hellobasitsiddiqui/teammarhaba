// TeamMarhaba Android WebView shell (TM-231) — self-contained Gradle build.
//
// The backend uses Maven (backend/pom.xml); this Android project is a SEPARATE, self-contained
// Gradle (Kotlin DSL) build under android/ — GENESIS mandates Gradle Kotlin DSL for Android. It is
// intentionally NOT wired into any root multi-project build: there is no green Android CI (the
// sandbox has no Android SDK), so this builds locally / in a human Android env via ./gradlew.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "teammarhaba-android"
include(":app")
