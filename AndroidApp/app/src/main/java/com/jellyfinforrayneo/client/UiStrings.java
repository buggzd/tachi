package com.jellyfinforrayneo.client;

import android.content.Context;
import android.content.res.Configuration;
import java.util.Locale;

/** Localize native system sheets/toasts without recreating either WebView. */
final class UiStrings
{
    private UiStrings() {}

    static String text(Context context, String language, String message)
    {
        int resource;
        switch (message)
        {
            case "选择手机背景":
                resource = R.string.choose_phone_wallpaper;
                break;
            case "无法打开图片选择器":
                resource = R.string.image_picker_unavailable;
                break;
            case "无法读取这张图片，请重新选择":
                resource = R.string.image_read_failed;
                break;
            case "手机背景已更新":
                resource = R.string.wallpaper_updated;
                break;
            case "图片未能保存，请选择 20 MB 以内的 JPG、PNG 或 WebP 图片":
                resource = R.string.wallpaper_save_failed;
                break;
            case "背景未能移除，请重试":
                resource = R.string.wallpaper_remove_failed;
                break;
            case "快速登录码已复制":
                resource = R.string.quick_connect_copied;
                break;
            case "无法打开授权页，请在 Jellyfin App 中手动授权。":
                resource = R.string.authorization_page_unavailable;
                break;
            case " 诊断日志":
                resource = R.string.diagnostics_subject_suffix;
                break;
            case "分享已脱敏诊断日志":
                resource = R.string.share_redacted_diagnostics;
                break;
            case "无法导出诊断日志，请重试。":
                resource = R.string.diagnostics_export_failed;
                break;
            case "没有可接收诊断日志的分享应用。":
                resource = R.string.share_app_unavailable;
                break;
            case "未找到可打开链接的浏览器":
                resource = R.string.browser_unavailable;
                break;
            default:
                return message;
        }
        Configuration configuration = new Configuration(context.getResources().getConfiguration());
        String system = configuration.getLocales().get(0).toLanguageTag();
        configuration.setLocale(Locale.forLanguageTag(UiLanguage.resolve(language, system)));
        return context.createConfigurationContext(configuration).getString(resource);
    }
}
