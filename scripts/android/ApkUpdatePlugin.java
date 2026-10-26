package com.chargerpointnew.apkupdate;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.Settings;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdatePlugin extends Plugin {
  private DownloadManager manager() {
    return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
  }

  @PluginMethod
  public void startDownload(PluginCall call) {
    String url = call.getString("url");
    String version = call.getString("version", "latest");
    if (url == null || url.trim().isEmpty()) {
      call.reject("رابط التحديث غير موجود.");
      return;
    }
    try {
      Uri uri = Uri.parse(url.trim());
      if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null) {
        call.reject("رابط التحديث يجب أن يكون HTTPS صالحًا.");
        return;
      }
      DownloadManager.Request request = new DownloadManager.Request(uri);
      request.setTitle("تحديث نقطة الشحن " + version);
      request.setDescription("جارٍ تنزيل ملف التحديث");
      request.setMimeType("application/vnd.android.package-archive");
      request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
      request.setAllowedOverMetered(true);
      request.setAllowedOverRoaming(true);
      request.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS,
          "chargerpoint-update-" + System.currentTimeMillis() + ".apk");
      long id = manager().enqueue(request);
      JSObject result = new JSObject();
      result.put("downloadId", String.valueOf(id));
      call.resolve(result);
    } catch (Exception e) {
      call.reject("تعذر بدء تنزيل التحديث.", e);
    }
  }

  @PluginMethod
  public void getProgress(PluginCall call) {
    String rawId = call.getString("downloadId");
    if (rawId == null) { call.reject("معرّف التنزيل مفقود."); return; }
    try {
      long id = Long.parseLong(rawId);
      DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
      try (Cursor cursor = manager().query(query)) {
        if (cursor == null || !cursor.moveToFirst()) {
          JSObject result = new JSObject();
          result.put("status", "missing");
          result.put("done", false);
          result.put("failed", true);
          result.put("reason", "لم يعثر أندرويد على مهمة التنزيل.");
          call.resolve(result);
          return;
        }
        int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
        long downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
        long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
        int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
        String state = "pending";
        boolean done = false;
        boolean failed = false;
        if (status == DownloadManager.STATUS_RUNNING) state = "running";
        else if (status == DownloadManager.STATUS_PAUSED) state = "paused";
        else if (status == DownloadManager.STATUS_SUCCESSFUL) { state = "successful"; done = true; }
        else if (status == DownloadManager.STATUS_FAILED) { state = "failed"; failed = true; }
        JSObject result = new JSObject();
        result.put("status", state);
        result.put("bytesDownloaded", downloaded);
        result.put("totalBytes", total);
        result.put("done", done);
        result.put("failed", failed);
        result.put("reason", reason);
        call.resolve(result);
      }
    } catch (Exception e) {
      call.reject("تعذر قراءة حالة التنزيل.", e);
    }
  }

  @PluginMethod
  public void install(PluginCall call) {
    String rawId = call.getString("downloadId");
    if (rawId == null) { call.reject("معرّف التنزيل مفقود."); return; }
    try {
      long id = Long.parseLong(rawId);
      Uri apkUri = manager().getUriForDownloadedFile(id);
      if (apkUri == null) {
        call.reject("ملف التحديث لم يكتمل تنزيله بعد.");
        return;
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
          && !getContext().getPackageManager().canRequestPackageInstalls()) {
        Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:" + getContext().getPackageName()));
        settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(settings);
        call.reject("INSTALL_PERMISSION_REQUIRED");
        return;
      }
      Intent intent = new Intent(Intent.ACTION_VIEW);
      intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
      getContext().startActivity(intent);
      call.resolve();
    } catch (Exception e) {
      call.reject("تعذر فتح مُثبّت أندرويد. تأكد من اكتمال التنزيل والسماح بتثبيت التطبيقات من هذا المصدر.", e);
    }
  }
}
