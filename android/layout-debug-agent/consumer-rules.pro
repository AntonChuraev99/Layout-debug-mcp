# Applied to apps that minify a build which includes the agent (normally only debug, which is not
# minified). The agent reaches LayoutNode's modifier by reflection; keep those accessors by name.
-keepclassmembers class androidx.compose.ui.node.LayoutNode {
    *** getModifier*(...);
    *** setModifier*(...);
}
-keep class io.github.antonchuraev99.layoutdebug.agent.LayoutDebugInitializer { <init>(); }
