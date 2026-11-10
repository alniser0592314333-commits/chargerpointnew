package com.chargerpointnew.biometric;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.security.keystore.KeyGenParameterSpec.Builder;
import android.content.SharedPreferences;
import android.security.keystore.KeyProperties;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.security.SecureRandom;
import android.util.Base64;
import android.os.Handler;
import android.os.Looper;
import androidx.fragment.app.FragmentActivity;
import androidx.lifecycle.Lifecycle;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.concurrent.Executor;

@CapacitorPlugin(name = "AccountBiometric")
public class AccountBiometricPlugin extends Plugin {
  private static final String STORE = "AndroidKeyStore";
  private static final String VAULT_KEY_ALIAS = "chargerpoint_admin_quick_login_v1";
  private static final String VAULT_PREFS = "cp_admin_secure_vault_v1";

  @PluginMethod
  public void isAvailable(PluginCall call) {
    BiometricManager manager = BiometricManager.from(getContext());
    int result = manager.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
    JSObject ret = new JSObject();
    ret.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
    call.resolve(ret);
  }

  @PluginMethod
  public void createKey(PluginCall call) {
    String alias = call.getString("alias");
    if (!validAlias(alias)) { call.reject("Invalid biometric key identifier"); return; }
    try {
      KeyStore store = KeyStore.getInstance(STORE);
      store.load(null);
      if (!store.containsAlias(alias)) {
        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE);
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .setUserAuthenticationRequired(true)
          .setInvalidatedByBiometricEnrollment(true);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
          spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
          spec.setUserAuthenticationValidityDurationSeconds(-1);
        }
        generator.initialize(spec.build());
        generator.generateKeyPair();
        store.load(null);
      }
      Certificate cert = store.getCertificate(alias);
      if (cert == null) { call.reject("Biometric public key is unavailable"); return; }
      JSObject ret = new JSObject();
      ret.put("publicKey", Base64.encodeToString(cert.getPublicKey().getEncoded(), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
      call.resolve(ret);
    } catch (Exception ex) {
      call.reject("Could not create a secure biometric key", ex);
    }
  }

  @PluginMethod
  public void signChallenge(PluginCall call) {
    String alias = call.getString("alias");
    String challenge = call.getString("challenge");
    if (!validAlias(alias) || challenge == null || challenge.length() != 64 || !challenge.matches("[a-f0-9]{64}")) {
      call.reject("Invalid biometric challenge"); return;
    }
    try {
      KeyStore store = KeyStore.getInstance(STORE);
      store.load(null);
      PrivateKey privateKey = (PrivateKey) store.getKey(alias, null);
      if (privateKey == null) { call.reject("Biometric key is missing; sign in with your password and enable biometrics again"); return; }
      Signature signature = Signature.getInstance("SHA256withECDSA");
      signature.initSign(privateKey);
      signature.update(challenge.getBytes(StandardCharsets.UTF_8));
      Signature signing = signature;
      FragmentActivity activity = (FragmentActivity) getActivity();
      Executor executor = activity.getMainExecutor();
      BiometricPrompt.AuthenticationCallback callback = new BiometricPrompt.AuthenticationCallback() {
        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
          try {
            Signature authorized = result.getCryptoObject() == null ? null : result.getCryptoObject().getSignature();
            if (authorized == null) { call.reject("Biometric signature operation failed"); return; }
            byte[] bytes = authorized.sign();
            JSObject ret = new JSObject();
            ret.put("signature", Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
            call.resolve(ret);
          } catch (Exception ex) { call.reject("Biometric signature operation failed", ex); }
        }
        @Override public void onAuthenticationError(int errorCode, CharSequence errString) {
          call.reject("BIOMETRIC_CANCELLED");
        }
        @Override public void onAuthenticationFailed() { /* Let Android permit another biometric attempt. */ }
      };
      BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
        .setTitle(call.getString("title", "Confirm your identity"))
        .setSubtitle(call.getString("subtitle", "Use your enrolled fingerprint"))
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButtonText(call.getString("negativeButtonText", "Cancel"))
        .build();
      // A tap immediately after a route change can arrive while Android is saving
      // FragmentManager state. Wait for the Activity to be resumed before opening
      // the OS prompt; otherwise the first tap can fail before the prompt appears.
      Handler mainHandler = new Handler(Looper.getMainLooper());
      int[] promptAttempts = new int[] { 0 };
      Runnable[] showPrompt = new Runnable[1];
      showPrompt[0] = () -> {
        if (activity.isFinishing() || activity.isDestroyed()) {
          call.reject("BIOMETRIC_PROMPT_NOT_READY");
          return;
        }
        boolean resumed = activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
        boolean stateSaved = activity.getSupportFragmentManager().isStateSaved();
        if (!resumed || stateSaved) {
          if (promptAttempts[0]++ < 12) mainHandler.postDelayed(showPrompt[0], 100);
          else call.reject("BIOMETRIC_PROMPT_NOT_READY");
          return;
        }
        try {
          BiometricPrompt prompt = new BiometricPrompt(activity, executor, callback);
          prompt.authenticate(info, new BiometricPrompt.CryptoObject(signing));
        } catch (Exception promptError) {
          if (promptAttempts[0]++ < 3) mainHandler.postDelayed(showPrompt[0], 120);
          else call.reject("Biometric prompt could not be opened", promptError);
        }
      };
      mainHandler.postDelayed(showPrompt[0], 120);
    } catch (Exception ex) { call.reject("Biometric signature operation failed", ex); }
  }

  @PluginMethod
  public void listAliases(PluginCall call) {
    try {
      KeyStore store = KeyStore.getInstance(STORE);
      store.load(null);
      JSArray aliases = new JSArray();
      java.util.Enumeration<String> names = store.aliases();
      while (names.hasMoreElements()) {
        String alias = names.nextElement();
        // This plugin creates random 128-bit hexadecimal aliases. Returning only
        // that exact format avoids exposing unrelated Keystore entries.
        if (validAlias(alias) && store.isKeyEntry(alias)) aliases.put(alias);
      }
      JSObject ret = new JSObject();
      ret.put("aliases", aliases);
      call.resolve(ret);
    } catch (Exception ex) {
      call.reject("Could not inspect biometric keys", ex);
    }
  }

  @PluginMethod
  public void deleteKey(PluginCall call) {
    String alias = call.getString("alias");
    if (!validAlias(alias)) { call.reject("Invalid biometric key identifier"); return; }
    try {
      KeyStore store = KeyStore.getInstance(STORE);
      store.load(null);
      store.deleteEntry(alias);
      JSObject ret = new JSObject(); ret.put("deleted", true); call.resolve(ret);
    } catch (Exception ex) { call.reject("Could not remove biometric key", ex); }
  }


  // Device-bound encrypted storage for saved-admin refresh tokens. The AES key
  // never leaves Android Keystore; SharedPreferences contains ciphertext only.
  @PluginMethod
  public void setSecureValue(PluginCall call) {
    String key = call.getString("key");
    String value = call.getString("value");
    if (!validVaultKey(key) || value == null || value.length() > 8192) {
      call.reject("Invalid secure storage input"); return;
    }
    try {
      SecretKey secret = getOrCreateVaultKey();
      byte[] iv = new byte[12];
      new SecureRandom().nextBytes(iv);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, secret, new GCMParameterSpec(128, iv));
      cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
      byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
      String packed = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" +
        Base64.encodeToString(encrypted, Base64.NO_WRAP);
      getContext().getSharedPreferences(VAULT_PREFS, Context.MODE_PRIVATE)
        .edit().putString("v_" + key, packed).commit();
      JSObject ret = new JSObject(); ret.put("saved", true); call.resolve(ret);
    } catch (Exception ex) { call.reject("Secure storage write failed", ex); }
  }

  @PluginMethod
  public void getSecureValue(PluginCall call) {
    String key = call.getString("key");
    if (!validVaultKey(key)) { call.reject("Invalid secure storage key"); return; }
    try {
      String packed = getContext().getSharedPreferences(VAULT_PREFS, Context.MODE_PRIVATE)
        .getString("v_" + key, null);
      if (packed == null) { JSObject ret = new JSObject(); ret.put("value", JSObject.NULL); call.resolve(ret); return; }
      String[] parts = packed.split(":", 2);
      if (parts.length != 2) throw new IllegalStateException("Invalid encrypted value");
      byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
      byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, getOrCreateVaultKey(), new GCMParameterSpec(128, iv));
      cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
      String value = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
      JSObject ret = new JSObject(); ret.put("value", value); call.resolve(ret);
    } catch (Exception ex) { call.reject("Secure storage read failed", ex); }
  }

  @PluginMethod
  public void deleteSecureValue(PluginCall call) {
    String key = call.getString("key");
    if (!validVaultKey(key)) { call.reject("Invalid secure storage key"); return; }
    boolean removed = getContext().getSharedPreferences(VAULT_PREFS, Context.MODE_PRIVATE)
      .edit().remove("v_" + key).commit();
    JSObject ret = new JSObject(); ret.put("deleted", removed); call.resolve(ret);
  }

  private SecretKey getOrCreateVaultKey() throws Exception {
    KeyStore store = KeyStore.getInstance(STORE);
    store.load(null);
    if (store.containsAlias(VAULT_KEY_ALIAS)) {
      return (SecretKey) store.getKey(VAULT_KEY_ALIAS, null);
    }
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
    KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
      VAULT_KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true);
    generator.init(spec.build());
    return generator.generateKey();
  }

  private boolean validVaultKey(String key) {
    return key != null && key.matches("[a-f0-9]{64}");
  }

  private boolean validAlias(String alias) {
    return alias != null && alias.matches("[a-f0-9]{32}");
  }
}
