# layout-debug Android agent

The on-device side of [layout-debug-mcp](../README.md#android) for Jetpack Compose apps.

| Module | What |
|---|---|
| `layout-debug-agent` | The agent: loopback HTTP server (`/tree`, `/screenshot`, `/override`, `/overrides/clear`, `/health`) reached through `adb forward`. For `debugImplementation`. |
| `layout-debug-noop` | The same `LayoutDebug` API with empty bodies, no dependencies. For `releaseImplementation`. |
| `sample` | A plain Compose app (Scaffold + LazyColumn) with both wired in. |

The HTTP contract is what [`src/server/android.ts`](../src/server/android.ts) reads; change both together. Errors are always `{"error":"…"}`: JSON routes answer them with 200, `/screenshot` with 503, refused requests with 4xx; the tool treats a non-2xx status or an `error` field as a failure on every route.

Shared settings of both libraries (SDK levels, Kotlin compatibility, publishing) live in one block in `build.gradle.kts`; a module gets them by applying `com.vanniktech.maven.publish`.

## Build

JDK 17 or newer (Android Studio's bundled JBR works) and an Android SDK, set in `local.properties` (`sdk.dir=…`, git-ignored) or `ANDROID_HOME`.

```bash
./gradlew :layout-debug-agent:testDebugUnitTest      # unit tests (HTTP guard, tree passes)
./gradlew :sample:installDebug                         # the sample with the agent
./gradlew :sample:assembleRelease :sample:verifyReleaseHasNoAgent   # release without agent code
adb forward tcp:8790 tcp:8790 && curl http://127.0.0.1:8790/health
```

`-PlayoutDebugPort=8791` builds the sample with the agent on another port (when another debug app holds 8790).

Compatibility check on a device or emulator (one row of the README table; CI runs every row):

```bash
ANDROID_SERIAL=emulator-5554 ./gradlew :sample:connectedDebugAndroidTest \
  -PcomposeBom=2024.09.00 -PactivityCompose=1.9.2 -PexpectedComposeUi=1.7.0
```

`ANDROID_SERIAL` keeps the run off other connected devices; `-PexpectedComposeUi` makes the test fail if a dependency pulled another Compose version in.

## Publishing (maintainers)

Artifacts go to Maven Central through the [Central Portal](https://central.sonatype.com) with [`com.vanniktech.maven.publish`](https://vanniktech.github.io/gradle-maven-publish-plugin/central/). Coordinates and POM are in `gradle.properties`. Nothing secret lives in this repository: credentials and the signing key come only from your `~/.gradle/gradle.properties` or `ORG_GRADLE_PROJECT_*` environment variables.

1. Once: verify the namespace `io.github.antonchuraev99` in the Central Portal (Namespaces), and generate a user token (Account → Generate User Token).
2. Once: a GPG key whose public part is on a key server (`gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>`).
3. Set, outside the repo:
   ```properties
   mavenCentralUsername=<token username>
   mavenCentralPassword=<token password>
   signingInMemoryKey=<ASCII-armored private key, e.g. gpg --export-secret-keys --armor <KEY_ID>>
   signingInMemoryKeyId=<last 8 characters of the key id>
   signingInMemoryKeyPassword=<key passphrase>
   ```
   Artifacts are signed only when a signing key is configured; Central rejects unsigned uploads.
4. Set `VERSION_NAME` in `gradle.properties` (the agent's `/health` `version` is generated from it) and the version in the setup lines of `README.md` and `README.ru.md`.
5. `./gradlew publishToMavenCentral`, then check the deployment in the Central Portal (Deployments) and press **Publish**. (`publishAndReleaseToMavenCentral` does both.)

`./gradlew publishToMavenLocal` needs no credentials and puts the same artifacts in `~/.m2` for a local check.
