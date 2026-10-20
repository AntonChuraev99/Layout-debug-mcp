# layout-debug Android agent

The on-device side of [layout-debug-mcp](../README.md#android) for Jetpack Compose apps.

| Module | What |
|---|---|
| `layout-debug-agent` | The agent: loopback HTTP server (`/tree`, `/screenshot`, `/override`, `/overrides/clear`, `/health`) reached through `adb forward`. For `debugImplementation`. |
| `layout-debug-noop` | The same `LayoutDebug` API with empty bodies, no dependencies. For `releaseImplementation`. |
| `sample` | A plain Compose app (Scaffold + LazyColumn) with both wired in. |

The HTTP contract is what [`src/server/android.ts`](../src/server/android.ts) reads; change both together.

## Build

JDK 17 or newer (Android Studio's bundled JBR works) and an Android SDK, set in `local.properties` (`sdk.dir=…`, git-ignored) or `ANDROID_HOME`.

```bash
./gradlew :layout-debug-agent:testDebugUnitTest      # unit tests (HTTP guard, tree passes)
./gradlew :sample:installDebug                         # the sample with the agent
./gradlew :sample:assembleRelease :sample:verifyReleaseHasNoAgent   # release without agent code
adb forward tcp:8790 tcp:8790 && curl http://127.0.0.1:8790/health
```

`-PlayoutDebugPort=8791` builds the sample with the agent on another port (when another debug app holds 8790).

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
4. Set `VERSION_NAME` in `gradle.properties` and the version in the root README setup lines.
5. `./gradlew publishToMavenCentral`, then check the deployment in the Central Portal (Deployments) and press **Publish**. (`publishAndReleaseToMavenCentral` does both.)

`./gradlew publishToMavenLocal` needs no credentials and puts the same artifacts in `~/.m2` for a local check.
