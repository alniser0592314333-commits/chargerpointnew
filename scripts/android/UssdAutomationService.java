package com.chargerpointnew.paymenthelper;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.os.Bundle;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;

public class UssdAutomationService extends AccessibilityService {
    private static final String PREFS = "cp_local_payment_helper_secure";
    private static final String KEY_ALIAS = "cp_local_payment_helper_aes_v1";
    private long lastActionAt = 0;

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.getEventType() != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)) return;
        CharSequence sourcePackage = event.getPackageName();
        String packageName = sourcePackage == null ? "" : sourcePackage.toString();
        if (!(packageName.equals("com.samsung.android.dialer") || packageName.equals("com.android.phone") ||
              packageName.equals("com.samsung.android.app.telephonyui") || packageName.equals("com.samsung.android.incallui") ||
              packageName.equals("com.android.server.telecom"))) return;
        if (System.currentTimeMillis() - lastActionAt < 900) return;
        try {
            android.content.SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String encrypted = prefs.getString("pending_steps_encrypted", null);
            if (encrypted == null) return;
            JSONArray steps = new JSONArray(decrypt(encrypted));
            int index = prefs.getInt("pending_step_index", 0);
            if (index >= steps.length()) return;
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return;

            List<AccessibilityNodeInfo> edits = new ArrayList<>();
            List<AccessibilityNodeInfo> buttons = new ArrayList<>();
            StringBuilder signature = new StringBuilder();
            collect(root, edits, buttons, signature);
            String prompt = signature.toString().trim();
            if (prompt.isEmpty() || prompt.equals(prefs.getString("last_dialog_signature", ""))) return;
            AccessibilityNodeInfo edit = edits.isEmpty() ? null : edits.get(0);
            AccessibilityNodeInfo send = null;
            for (AccessibilityNodeInfo button : buttons) {
                CharSequence label = button.getText();
                String text = label == null ? "" : label.toString().trim().toLowerCase(java.util.Locale.ROOT);
                if (text.equals("send") || text.equals("إرسال") || text.equals("ارسال") ||
                    text.equals("ok") || text.equals("موافق") || text.equals("التالي") || text.equals("continue")) {
                    send = button; break;
                }
            }
            if (edit == null || send == null) return;
            String value = steps.optString(index, "");
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value);
            if (!edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return;
            if (!send.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return;
            prefs.edit().putString("last_dialog_signature", prompt).putInt("pending_step_index", index + 1).apply();
            lastActionAt = System.currentTimeMillis();
        } catch (Exception ignored) {
            // Never log PINs, USSD prompt contents, or step values.
        }
    }

    private void collect(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> edits,
                         List<AccessibilityNodeInfo> buttons, StringBuilder signature) {
        if (node == null) return;
        CharSequence cls = node.getClassName();
        if (node.isEditable() || (cls != null && cls.toString().contains("EditText"))) edits.add(node);
        if (node.isClickable() && node.isEnabled()) buttons.add(node);
        CharSequence text = node.getText();
        if (text != null && text.length() > 0 && !node.isEditable()) signature.append(text).append('|');
        for (int i = 0; i < node.getChildCount(); i++) collect(node.getChild(i), edits, buttons, signature);
    }

    private String decrypt(String encoded) throws Exception {
        byte[] combined = Base64.decode(encoded, Base64.NO_WRAP);
        int ivLength = 12;
        byte[] iv = Arrays.copyOfRange(combined, 0, ivLength);
        byte[] ciphertext = Arrays.copyOfRange(combined, ivLength, combined.length);
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey key = (SecretKey) store.getKey(KEY_ALIAS, null);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    @Override public void onInterrupt() { }
}