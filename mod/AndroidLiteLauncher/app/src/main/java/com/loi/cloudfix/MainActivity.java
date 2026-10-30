package com.loi.cloudfix;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final int REQUEST_OVERLAY_PERMISSION = 1001;
    private static final String SITE_URL = "https://loim9347-a11y.github.io/cloudfixloi/";
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(Color.WHITE);

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(12), dp(6), dp(12), dp(6));
        toolbar.setBackgroundColor(Color.rgb(25, 45, 70));

        TextView title = new TextView(this);
        title.setText("CloudFix Loi");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));

        Button openOverlay = new Button(this);
        openOverlay.setText("Mở cửa sổ nổi");
        openOverlay.setOnClickListener(view -> openOverlay());
        toolbar.addView(openOverlay);

        webView = new WebView(this);
        configureWebView(webView);
        webView.loadUrl(SITE_URL);

        page.addView(toolbar);
        page.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(page);
    }

    private void configureWebView(WebView view) {
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.setWebViewClient(new WebViewClient());
        view.setWebChromeClient(new WebChromeClient());
    }

    private void openOverlay() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            Intent permissionIntent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            startActivityForResult(permissionIntent, REQUEST_OVERLAY_PERMISSION);
            return;
        }
        startOverlayService();
    }

    private void startOverlayService() {
        Intent serviceIntent = new Intent(this, OverlayService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_OVERLAY_PERMISSION) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)) {
                startOverlayService();
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}
