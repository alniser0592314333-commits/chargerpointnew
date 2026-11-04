package com.chargerpoint.nativesms;

import android.Manifest;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;

@CapacitorPlugin(
    name = "NativeSms",
    permissions = {
        @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS })
    }
)
public class NativeSmsPlugin extends Plugin {

    @PluginMethod
    public void sendSms(PluginCall call) {
        String phone = call.getString("phone");
        String message = call.getString("message");

        if (TextUtils.isEmpty(phone) || TextUtils.isEmpty(message)) {
            call.reject("PHONE_AND_MESSAGE_REQUIRED");
            return;
        }

        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermissionCallback");
            return;
        }

        sendUsingSystemDefaultSim(call, phone.trim(), message);
    }

    @PermissionCallback
    private void smsPermissionCallback(PluginCall call) {
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            call.reject("SMS_PERMISSION_DENIED");
            return;
        }

        String phone = call.getString("phone");
        String message = call.getString("message");
        if (TextUtils.isEmpty(phone) || TextUtils.isEmpty(message)) {
            call.reject("PHONE_AND_MESSAGE_REQUIRED");
            return;
        }

        sendUsingSystemDefaultSim(call, phone.trim(), message);
    }

    private void sendUsingSystemDefaultSim(PluginCall call, String phone, String message) {
        try {
            // SmsManager.getDefault() follows Android's system-selected default SMS subscription.
            SmsManager defaultManager = SmsManager.getDefault();
            int subscriptionId = defaultManager.getSubscriptionId();
            if (subscriptionId == SubscriptionManager.INVALID_SUBSCRIPTION_ID || subscriptionId < 0) {
                call.reject("NO_DEFAULT_SMS_SIM");
                return;
            }

            // Pin this send to the selected subscription so the OS cannot silently fall back
            // to a different SIM between checking the default and submitting the message.
            SmsManager manager = SmsManager.getSmsManagerForSubscriptionId(subscriptionId);
            ArrayList<String> parts = manager.divideMessage(message);
            if (parts == null || parts.isEmpty()) {
                call.reject("SMS_MESSAGE_COULD_NOT_BE_SPLIT");
                return;
            }

            if (parts.size() == 1) {
                manager.sendTextMessage(phone, null, parts.get(0), null, null);
            } else {
                manager.sendMultipartTextMessage(phone, null, parts, null, null);
            }

            JSObject result = new JSObject();
            result.put("status", "submitted");
            result.put("subscriptionId", subscriptionId);
            result.put("parts", parts.size());
            // "submitted" means accepted by Android's SMS service, not carrier delivery.
            call.resolve(result);
        } catch (SecurityException error) {
            call.reject("SMS_PERMISSION_DENIED", error);
        } catch (IllegalArgumentException error) {
            call.reject("SMS_INVALID_ARGUMENT", error);
        } catch (Exception error) {
            call.reject("SMS_SUBMISSION_FAILED", error);
        }
    }
}
