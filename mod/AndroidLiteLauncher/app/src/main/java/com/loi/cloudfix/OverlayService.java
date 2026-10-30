package com.loi.cloudfix;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class OverlayService extends Service {
    private static final String CHANNEL_ID = "cloudfix_overlay";
    private static final int NOTIFICATION_ID = 41;
    private static final String ACTION_STOP = "com.loi.cloudfix.STOP_OVERLAY";
    private static final String SITE_URL = "https://loim9347-a11y.github.io/cloudfixloi/";
    private WindowManager windowManager;
    private WindowManager.LayoutParams popupParams;
    private WindowManager.LayoutParams bubbleParams;
    private FrameLayout popup;
    private WebView webView;
    private TextView bubble;
    private PowerManager.WakeLock wakeLock;
    private boolean popupVisible;

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && !Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        keepCpuAwake();
        if (popup == null && bubble == null) {
            showPopup();
        } else if (bubble != null) {
            expandPopup();
        }
        return START_STICKY;
    }

    private void showPopup() {
        int screenWidth = getResources().getDisplayMetrics().widthPixels;
        int screenHeight = getResources().getDisplayMetrics().heightPixels;
        int width = Math.min(dp(360), screenWidth - dp(24));
        int height = Math.min(dp(500), screenHeight - dp(80));

        popup = new FrameLayout(this);
        popup.setBackground(roundRect(Color.WHITE, dp(14)));
        popup.setClipToOutline(true);

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        popup.addView(content, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(10), 0, dp(4), 0);
        header.setBackgroundColor(Color.rgb(25, 45, 70));

        TextView title = new TextView(this);
        title.setText("CloudFix Loi");
        title.setTextColor(Color.WHITE);
        title.setTextSize(15);
        header.addView(title, new LinearLayout.LayoutParams(0, dp(44), 1));

        TextView minimize = createHeaderButton("−");
        minimize.setOnClickListener(view -> minimizePopup());
        header.addView(minimize, new LinearLayout.LayoutParams(dp(42), dp(44)));

        TextView close = createHeaderButton("×");
        close.setOnClickListener(view -> stopSelf());
        header.addView(close, new LinearLayout.LayoutParams(dp(42), dp(44)));

        header.setOnTouchListener(new DragTouchListener(false));
        content.addView(header, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(44)));

        webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.loadUrl(SITE_URL);
        content.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));

        FrameLayout resizeBar = new FrameLayout(this);
        resizeBar.setBackgroundColor(Color.rgb(232, 238, 245));
        TextView resize = new TextView(this);
        resize.setText("◢");
        resize.setTextColor(Color.rgb(25, 45, 70));
        resize.setTextSize(18);
        resize.setGravity(Gravity.CENTER);
        resize.setOnTouchListener(new ResizeTouchListener());
        resizeBar.addView(resize, new FrameLayout.LayoutParams(
                dp(42), dp(28), Gravity.END | Gravity.CENTER_VERTICAL));
        content.addView(resizeBar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(28)));

        popupParams = new WindowManager.LayoutParams(
                width, height, windowType(),
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        popupParams.gravity = Gravity.TOP | Gravity.START;
        popupParams.x = dp(12);
        popupParams.y = dp(60);
        windowManager.addView(popup, popupParams);
        popupVisible = true;
    }

    private TextView createHeaderButton(String text) {
        TextView button = new TextView(this);
        button.setText(text);
        button.setTextColor(Color.WHITE);
        button.setTextSize(24);
        button.setGravity(Gravity.CENTER);
        button.setBackground(selectableBackground());
        return button;
    }

    private void minimizePopup() {
        if (!popupVisible || popup == null) {
            return;
        }
        int x = popupParams.x;
        int y = popupParams.y;
        windowManager.removeView(popup);
        popupVisible = false;

        bubble = new TextView(this);
        bubble.setText("CF");
        bubble.setTextColor(Color.WHITE);
        bubble.setTextSize(14);
        bubble.setGravity(Gravity.CENTER);
        bubble.setBackground(roundRect(Color.rgb(25, 45, 70), dp(28)));
        bubble.setElevation(dp(8));
        bubble.setOnTouchListener(new DragTouchListener(true));
        bubbleParams = new WindowManager.LayoutParams(
                dp(56), dp(56), windowType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        bubbleParams.x = x;
        bubbleParams.y = y;
        windowManager.addView(bubble, bubbleParams);
    }

    private void expandPopup() {
        if (bubble != null) {
            popupParams.x = bubbleParams.x;
            popupParams.y = bubbleParams.y;
            windowManager.removeView(bubble);
            bubble = null;
        }
        if (popup != null && !popupVisible) {
            windowManager.addView(popup, popupParams);
            popupVisible = true;
        }
    }

    private class DragTouchListener implements View.OnTouchListener {
        private final boolean isBubble;
        private float downX;
        private float downY;
        private int initialX;
        private int initialY;
        private boolean moved;

        DragTouchListener(boolean isBubble) {
            this.isBubble = isBubble;
        }

        @Override
        public boolean onTouch(View view, MotionEvent event) {
            WindowManager.LayoutParams params = isBubble ? bubbleParams : popupParams;
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    downX = event.getRawX();
                    downY = event.getRawY();
                    initialX = params.x;
                    initialY = params.y;
                    moved = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    int dx = (int) (event.getRawX() - downX);
                    int dy = (int) (event.getRawY() - downY);
                    if (Math.abs(dx) + Math.abs(dy) > dp(4)) {
                        moved = true;
                    }
                    params.x = clamp(initialX + dx, 0, getResources().getDisplayMetrics().widthPixels
                            - (isBubble ? view.getWidth() : params.width));
                    params.y = clamp(initialY + dy, 0, getResources().getDisplayMetrics().heightPixels
                            - (isBubble ? view.getHeight() : params.height));
                    windowManager.updateViewLayout(view, params);
                    return true;
                case MotionEvent.ACTION_UP:
                    if (isBubble && !moved) {
                        expandPopup();
                    }
                    return true;
                default:
                    return true;
            }
        }
    }

    private class ResizeTouchListener implements View.OnTouchListener {
        private float downX;
        private float downY;
        private int initialWidth;
        private int initialHeight;

        @Override
        public boolean onTouch(View view, MotionEvent event) {
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    downX = event.getRawX();
                    downY = event.getRawY();
                    initialWidth = popupParams.width;
                    initialHeight = popupParams.height;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    int maxWidth = getResources().getDisplayMetrics().widthPixels;
                    int maxHeight = getResources().getDisplayMetrics().heightPixels;
                    popupParams.width = clamp(initialWidth + (int) (event.getRawX() - downX),
                            dp(240), maxWidth);
                    popupParams.height = clamp(initialHeight + (int) (event.getRawY() - downY),
                            dp(180), maxHeight);
                    windowManager.updateViewLayout(popup, popupParams);
                    return true;
                default:
                    return true;
            }
        }
    }

    private void keepCpuAwake() {
        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = powerManager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK, "CloudFixLoi:WebView");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) {
            wakeLock.acquire();
        }
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
                this, 0, openIntent, pendingIntentFlags());
        Intent stopIntent = new Intent(this, OverlayService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this, 1, stopIntent, pendingIntentFlags());

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle("CloudFix Loi đang chạy")
                .setContentText("Cửa sổ nổi vẫn hoạt động trong nền")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentIntent(openPendingIntent)
                .setOngoing(true)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dừng", stopPendingIntent);
        return builder.build();
    }

    private int pendingIntentFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
    }

    private int windowType() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Cửa sổ nổi", NotificationManager.IMPORTANCE_LOW);
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(channel);
        }
    }

    private GradientDrawable roundRect(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        return drawable;
    }

    private android.graphics.drawable.Drawable selectableBackground() {
        android.util.TypedValue value = new android.util.TypedValue();
        getTheme().resolveAttribute(android.R.attr.selectableItemBackground, value, true);
        return getDrawable(value.resourceId);
    }

    private int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, Math.max(min, max)));
    }

    private int dp(float value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    public void onDestroy() {
        if (popup != null && popupVisible) {
            windowManager.removeView(popup);
        }
        if (bubble != null) {
            windowManager.removeView(bubble);
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
