package com.chargerpointnew.biometric;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.ComponentActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import com.getcapacitor.JSObject;
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
      ComponentActivity activity = (ComponentActivity) getActivity();
      Executor executor = activity.getMainExecutor();
      BiometricPrompt prompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
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
      });
      BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
        .setTitle(call.getString("title", "Confirm your identity"))
        .setSubtitle(call.getString("subtitle", "Use your enrolled fingerprint"))
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .setNegativeButtonText("Cancel")
        .build();
      prompt.authenticate(info, new BiometricPrompt.CryptoObject(signing));
    } catch (Exception ex) { call.reject("Biometric signature operation failed", ex); }
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

  private boolean validAlias(String alias) {
    return alias != null && alias.matches("[a-f0-9]{32}");
  }
}
