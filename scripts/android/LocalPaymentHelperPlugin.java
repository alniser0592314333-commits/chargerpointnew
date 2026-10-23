package com.chargerpointnew.paymenthelper;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import com.getcapacitor.JSObject;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(
    name = "LocalPaymentHelper",
    permissions = {
        @Permission(alias = "call", strings = { Manifest.permission.CALL_PHONE })
    }
)
public class LocalPaymentHelperPlugin extends Plugin {
    private static final String PREFS = "cp_local_payment_helper_secure";
    private static final String DATA_KEY = "services_ciphertext";
    private static final String KEY_ALIAS = "cp_local_payment_helper_aes_v1";

    @PluginMethod
    public void getServices(PluginCall call) {
        try {
            String encrypted = prefs().getString(DATA_KEY, null);
            JSObject result = new JSObject();
            result.put("value", encrypted == null ? "" : decrypt(encrypted));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("تعذر فتح الخدمات المحلية الآمنة على هذا الجهاز.");
        }
    }

    @PluginMethod
    public void setServices(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.length() > 100000) {
            call.reject("بيانات الخدمات غير صالحة.");
            return;
        }
        try {
            prefs().edit().putString(DATA_KEY, encrypt(value)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("تعذر حفظ الخدمات المحلية الآمنة على هذا الجهاز.");
        }
    }

    @PluginMethod
    public void placeCall(PluginCall call) {
        String code = call.getString("code");
        if (code == null || !code.matches("^\\*110\\*[12]\\*\\d{4}\\*\\d{8,15}\\*\\d+(?:\\.\\d{1,2})?\\*1#$")) {
            call.reject("رمز الاتصال غير صالح.");
            return;
        }
        if (getPermissionState("call") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("call", call, "callPermissionResult");
            return;
        }
        performCall(call, code);
    }

    @PermissionCallback
    private void callPermissionResult(PluginCall call) {
        if (getPermissionState("call") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("يلزم السماح بصلاحية الاتصال لبدء الاتصال المباشر.");
            return;
        }
        String code = call.getString("code");
        if (code == null || !code.matches("^\\*110\\*[12]\\*\\d{4}\\*\\d{8,15}\\*\\d+(?:\\.\\d{1,2})?\\*1#$")) {
            call.reject("رمز الاتصال غير صالح.");
            return;
        }
        performCall(call, code);
    }

    private void performCall(PluginCall call, String code) {
        try {
            // Keep * characters intact for USSD and encode # so Android does not
            // interpret it as a URI fragment. The PIN is never written to logs.
            Uri uri = Uri.parse("tel:" + Uri.encode(code, "*"));
            Intent intent = new Intent(Intent.ACTION_CALL, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("تعذر بدء اتصال USSD على هذا الجهاز.");
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
         .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
         .setRandomizedEncryptionRequired(true)
         .build());
        return generator.generateKey();
    }

    private String encrypt(String plainText) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(plainText.getBytes(StandardCharsets.UTF_8));
        byte[] combined = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(encrypted, 0, combined, iv.length, encrypted.length);
        return android.util.Base64.encodeToString(combined, android.util.Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        byte[] combined = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
        int ivLength = 12;
        if (combined.length <= ivLength) throw new IllegalArgumentException("Invalid ciphertext");
        byte[] iv = Arrays.copyOfRange(combined, 0, ivLength);
        byte[] ciphertext = Arrays.copyOfRange(combined, ivLength, combined.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }
}
