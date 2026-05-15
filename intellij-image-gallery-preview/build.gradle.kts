import org.gradle.api.tasks.wrapper.Wrapper
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

plugins {
    id("org.jetbrains.intellij.platform") version "2.16.0"
    kotlin("jvm") version "2.1.0"
}

group = "com.yourorg"

val versionFile = layout.projectDirectory.file("version.txt").asFile

fun readVersionFromFile(): String {
    if (!versionFile.exists()) {
        versionFile.writeText("0.0.1\n")
    }
    return versionFile.readText().trim().ifBlank { "0.0.1" }
}

val configuredVersion = readVersionFromFile()
version = configuredVersion

repositories {
    maven(url = "https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("org.yaml:snakeyaml:2.2")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("com.drewnoakes:metadata-extractor:2.19.0")
    implementation("org.apache.commons:commons-imaging:1.0.0-alpha5")
    implementation("org.openjfx:javafx-base:21.0.5:win")
    implementation("org.openjfx:javafx-controls:21.0.5:win")
    implementation("org.openjfx:javafx-graphics:21.0.5:win")
    implementation("org.openjfx:javafx-media:21.0.5:win")
    implementation("org.openjfx:javafx-swing:21.0.5:win")
    testImplementation(kotlin("test"))

    intellijPlatform {
        local("D:/Program Files/Android/Android Studio")
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.provider { project.version.toString() }
    }
}

tasks {
    named("verifyPluginProjectConfiguration") { enabled = false }
    named("buildSearchableOptions") { enabled = false }
    named<Copy>("processResources") {
        from(rootProject.layout.projectDirectory.dir("../gallery-web")) {
            into("gallery-web")
        }
    }

    withType<JavaCompile> {
        sourceCompatibility = "17"
        targetCompatibility = "17"
    }

    withType<KotlinCompile> {
        kotlinOptions {
            jvmTarget = "17"
            freeCompilerArgs += "-Xskip-metadata-version-check"
        }
    }

    register<Copy>("copyPluginZipToOutput") {
        dependsOn("buildPlugin")
        doFirst {
            delete(layout.projectDirectory.dir("output"))
        }
        from(layout.buildDirectory.dir("distributions"))
        include("intellij-image-gallery-preview-${project.version}.zip")
        into(layout.projectDirectory.dir("output"))
    }

    register("printCurrentVersion") {
        doLast {
            val stamp = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").format(LocalDateTime.now())
            logger.lifecycle("[$stamp] Current plugin version: ${project.version}")
        }
    }

    wrapper {
        gradleVersion = "9.2.0"
        distributionType = Wrapper.DistributionType.BIN
    }
}
