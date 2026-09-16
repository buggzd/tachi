# ORT JNI looks up constructors, enums and fields by name; the local QNN AAR
# does not ship consumer rules. Keeping only native methods is insufficient.
-keep class ai.onnxruntime.** { *; }

# JavaScript bridge entry points are invoked by Chromium.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
