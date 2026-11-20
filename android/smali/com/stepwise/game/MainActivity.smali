.class public Lcom/stepwise/game/MainActivity;
.super Landroid/app/Activity;
.source "MainActivity.java"


# instance fields
.field private webView:Landroid/webkit/WebView;

.field private vibrator:Landroid/os/Vibrator;

.field private bridge:Lcom/stepwise/game/NativeBridge;


# direct methods
.method public constructor <init>()V
    .registers 1

    invoke-direct {p0}, Landroid/app/Activity;-><init>()V

    return-void
.end method


# virtual methods
.method public onBackPressed()V
    .registers 2

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    if-eqz v0, :cond_12

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {v0}, Landroid/webkit/WebView;->canGoBack()Z

    move-result v0

    if-eqz v0, :cond_12

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {v0}, Landroid/webkit/WebView;->goBack()V

    goto :goto_15

    :cond_12
    invoke-super {p0}, Landroid/app/Activity;->onBackPressed()V

    :goto_15
    return-void
.end method

.method protected onCreate(Landroid/os/Bundle;)V
    .registers 8

    invoke-super {p0, p1}, Landroid/app/Activity;->onCreate(Landroid/os/Bundle;)V

    :try_start_3
    new-instance p1, Landroid/webkit/WebView;

    invoke-direct {p1, p0}, Landroid/webkit/WebView;-><init>(Landroid/content/Context;)V

    iput-object p1, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    iget-object p1, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {p1}, Landroid/webkit/WebView;->getSettings()Landroid/webkit/WebSettings;

    move-result-object p1

    const/4 v0, 0x1

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setJavaScriptEnabled(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setDomStorageEnabled(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setDatabaseEnabled(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setAllowFileAccess(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setAllowContentAccess(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setAllowFileAccessFromFileURLs(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setAllowUniversalAccessFromFileURLs(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setMediaPlaybackRequiresUserGesture(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setJavaScriptCanOpenWindowsAutomatically(Z)V

    const/4 v1, 0x0

    invoke-virtual {p1, v1}, Landroid/webkit/WebSettings;->setSupportMultipleWindows(Z)V

    invoke-virtual {p1, v1}, Landroid/webkit/WebSettings;->setBuiltInZoomControls(Z)V

    invoke-virtual {p1, v1}, Landroid/webkit/WebSettings;->setDisplayZoomControls(Z)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebSettings;->setMediaPlaybackRequiresUserGesture(Z)V

    invoke-static {}, Landroid/webkit/CookieManager;->getInstance()Landroid/webkit/CookieManager;

    move-result-object p1

    invoke-virtual {p1, v0}, Landroid/webkit/CookieManager;->setAcceptCookie(Z)V

    iget-object v2, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {p1, v2, v0}, Landroid/webkit/CookieManager;->setAcceptThirdPartyCookies(Landroid/webkit/WebView;Z)V

    # Native bridge: haptics + fps reporting for the native wrapper.
    new-instance p1, Lcom/stepwise/game/NativeBridge;

    invoke-direct {p1, p0}, Lcom/stepwise/game/NativeBridge;-><init>(Lcom/stepwise/game/MainActivity;)V

    iput-object p1, p0, Lcom/stepwise/game/MainActivity;->bridge:Lcom/stepwise/game/NativeBridge;

    iget-object p1, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    new-instance v0, Lcom/stepwise/game/MainActivity$1;

    invoke-direct {v0, p0}, Lcom/stepwise/game/MainActivity$1;-><init>(Lcom/stepwise/game/MainActivity;)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebView;->setWebViewClient(Landroid/webkit/WebViewClient;)V

    iget-object p1, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    new-instance v0, Lcom/stepwise/game/MainActivity$2;

    invoke-direct {v0, p0}, Lcom/stepwise/game/MainActivity$2;-><init>(Lcom/stepwise/game/MainActivity;)V

    invoke-virtual {p1, v0}, Landroid/webkit/WebView;->setWebChromeClient(Landroid/webkit/WebChromeClient;)V

    # Add the JavaScript interface used by the web game for native haptics.
    iget-object p1, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    iget-object v2, p0, Lcom/stepwise/game/MainActivity;->bridge:Lcom/stepwise/game/NativeBridge;

    const-string v0, "StepwiseNative"

    invoke-virtual {p1, v0, v2}, Landroid/webkit/WebView;->addJavascriptInterface(Ljava/lang/Object;Ljava/lang/String;)V

    iget-object p1, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    const-string v0, "file:///android_asset/www/index.html"

    invoke-virtual {p1, v0}, Landroid/webkit/WebView;->loadUrl(Ljava/lang/String;)V

    iget-object p1, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {p0, p1}, Landroid/app/Activity;->setContentView(Landroid/view/View;)V

    # Acquire the vibrator for native haptics.
    :try_start_64
    invoke-virtual {p0}, Landroid/app/Activity;->getSystemService(Ljava/lang/String;)Ljava/lang/Object;

    move-result-object v0

    check-cast v0, Landroid/os/Vibrator;

    iput-object v0, p0, Lcom/stepwise/game/MainActivity;->vibrator:Landroid/os/Vibrator;
    :try_end_64
    .catchall {:try_start_3 .. :try_end_64} :catchall_aa

    # Enter immersive fullscreen so the game owns the whole screen.
    :try_start_70
    invoke-virtual {p0}, Lcom/stepwise/game/MainActivity;->enterImmersiveMode()V
    :try_end_70
    .catchall {:try_start_70 .. :try_end_70} :catchall_bb

    :catchall_bb
    goto :goto_ae

    :catchall_aa
    move-exception p1

    invoke-virtual {p1}, Ljava/lang/Throwable;->printStackTrace()V

    :goto_ae
    return-void
.end method

.method private enterImmersiveMode()V
    .registers 3

    invoke-virtual {p0}, Landroid/app/Activity;->getWindow()Landroid/view/Window;

    move-result-object v0

    invoke-virtual {v0, v1}, Landroid/view/Window;->getDecorView()Landroid/view/View;

    move-result-object v0

    const/16 v1, 0x6

    const/16 v2, 0x2

    invoke-virtual {v0, v1, v2}, Landroid/view/View;->setSystemUiVisibility(I)V

    return-void
.end method

.method protected onDestroy()V
    .registers 2

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    if-eqz v0, :cond_9

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {v0}, Landroid/webkit/WebView;->destroy()V

    :cond_9
    invoke-super {p0}, Landroid/app/Activity;->onDestroy()V

    return-void
.end method

.method protected onPause()V
    .registers 2

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    if-eqz v0, :cond_9

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {v0}, Landroid/webkit/WebView;->onPause()V

    :cond_9
    invoke-super {p0}, Landroid/app/Activity;->onPause()V

    return-void
.end method

.method protected onResume()V
    .registers 2

    invoke-super {p0}, Landroid/app/Activity;->onResume()V

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    if-eqz v0, :cond_c

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->webView:Landroid/webkit/WebView;

    invoke-virtual {v0}, Landroid/webkit/WebView;->onResume()V

    :cond_c
    return-void
.end method

.method public onWindowFocusChanged(Z)V
    .registers 2

    invoke-super {p0, p1}, Landroid/app/Activity;->onWindowFocusChanged(Z)V

    if-eqz p1, :cond_focus_lost

    invoke-virtual {p0}, Lcom/stepwise/game/MainActivity;->enterImmersiveMode()V

    :cond_focus_lost
    return-void
.end method

.method public vibrate(I)V
    .registers 3

    iget-object v0, p0, Lcom/stepwise/game/MainActivity;->vibrator:Landroid/os/Vibrator;

    if-eqz v0, :cond_no_vibe

    :try_start_10
    invoke-virtual {v0, p1}, Landroid/os/Vibrator;->vibrate(I)V
    :try_end_10
    .catchall {:try_start_10 .. :try_end_10} :catchall_20

    :catchall_20
    goto :cond_no_vibe

    :cond_no_vibe
    return-void
.end method
