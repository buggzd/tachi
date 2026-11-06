package com.jellyfinforrayneo.client;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

final class JellyfinAuthenticationService
{
    private static final int HTTP_TIMEOUT_MS = 15_000;
    private static final int QUICK_CONNECT_TIMEOUT_MS = 300_000;
    private static final int QUICK_CONNECT_POLL_MS = 1_500;
    private static final int MAX_RESPONSE_LENGTH = 1_048_576;
    private static final int MAX_PASSWORD_LENGTH = 4_096;

    interface Callback
    {
        void onQuickConnectCode(int generation, String code);

        void onAuthenticated(int generation, SessionPayload session, boolean persist);

        void onError(int generation, String message);
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable ->
    {
        Thread thread = new Thread(runnable, "Jellyfin-Authentication");
        thread.setDaemon(true);
        return thread;
    });
    private final SessionRepository sessions;
    private final Callback callback;
    private final String deviceName;
    private volatile int generation;

    JellyfinAuthenticationService(
            SessionRepository sessions,
            String deviceName,
            Callback callback)
    {
        this.sessions = sessions;
        this.deviceName = headerSafe(deviceName);
        this.callback = callback;
    }

    int login(String serverValue, String userValue, String passwordValue, boolean persist)
    {
        final int operation = ++generation;
        final String serverInput = bounded(serverValue, SessionPayload.MAX_SERVER_URL_LENGTH);
        final String username = bounded(userValue, SessionPayload.MAX_USER_NAME_LENGTH).trim();
        final char[] password = bounded(passwordValue, MAX_PASSWORD_LENGTH).toCharArray();
        executor.execute(() ->
        {
            try
            {
                String serverUrl = SessionPayload.normalizeServerUrl(serverInput);
                if (username.isEmpty())
                {
                    throw new UserVisibleException("请输入 Jellyfin 用户名。");
                }
                JSONObject publicInfo = requestJson("GET", serverUrl + "/System/Info/Public", null);
                JSONObject request = new JSONObject();
                JSONObject authentication;
                try
                {
                    request.put("Username", username);
                    request.put("Pw", new String(password));
                    authentication = requestJson(
                            "POST",
                            serverUrl + "/Users/AuthenticateByName",
                            request);
                }
                finally
                {
                    request.remove("Pw");
                }
                SessionPayload session = createSession(serverUrl, publicInfo, authentication);
                if (operation == generation)
                {
                    callback.onAuthenticated(operation, session, persist);
                }
            }
            catch (Exception exception)
            {
                if (operation == generation)
                {
                    callback.onError(operation, friendlyError(exception));
                }
            }
            finally
            {
                Arrays.fill(password, '\0');
            }
        });
        return operation;
    }

    int quickConnect(String serverValue, boolean persist)
    {
        final int operation = ++generation;
        final String serverInput = bounded(serverValue, SessionPayload.MAX_SERVER_URL_LENGTH);
        executor.execute(() -> runQuickConnect(operation, serverInput, persist));
        return operation;
    }

    void cancel()
    {
        generation++;
    }

    boolean isCurrent(int operation)
    {
        return operation == generation;
    }

    void close()
    {
        generation++;
        executor.shutdownNow();
    }

    private void runQuickConnect(int operation, String serverInput, boolean persist)
    {
        try
        {
            String serverUrl = SessionPayload.normalizeServerUrl(serverInput);
            String enabled = requestText("GET", serverUrl + "/QuickConnect/Enabled", null);
            if (!"true".equalsIgnoreCase(enabled.trim()))
            {
                throw new UserVisibleException(
                        "此 Jellyfin 服务器未启用快速连接，请使用账户密码登录。");
            }

            JSONObject publicInfo = requestJson("GET", serverUrl + "/System/Info/Public", null);
            JSONObject initiated = requestJson("POST", serverUrl + "/QuickConnect/Initiate", null);
            String secret = bounded(stringValue(initiated, "Secret"), 4_096).trim();
            String code = bounded(stringValue(initiated, "Code"), 32).trim();
            if (secret.isEmpty() || code.isEmpty())
            {
                throw new UserVisibleException("服务器没有返回有效的快速登录码。");
            }

            if (operation != generation)
            {
                return;
            }
            callback.onQuickConnectCode(operation, code);

            long deadline = System.currentTimeMillis() + QUICK_CONNECT_TIMEOUT_MS;
            boolean authenticated = initiated.optBoolean("Authenticated", false);
            while (operation == generation
                    && !authenticated
                    && System.currentTimeMillis() < deadline)
            {
                Thread.sleep(QUICK_CONNECT_POLL_MS);
                if (operation != generation)
                {
                    return;
                }
                String encodedSecret = URLEncoder.encode(secret, StandardCharsets.UTF_8.name());
                JSONObject state = requestJson(
                        "GET",
                        serverUrl + "/QuickConnect/Connect?secret=" + encodedSecret,
                        null);
                authenticated = state.optBoolean("Authenticated", false);
            }

            if (operation != generation)
            {
                return;
            }
            if (!authenticated)
            {
                throw new UserVisibleException("快速登录码已过期，请重新申请。");
            }

            JSONObject request = new JSONObject();
            JSONObject authentication;
            try
            {
                request.put("Secret", secret);
                authentication = requestJson(
                        "POST",
                        serverUrl + "/Users/AuthenticateWithQuickConnect",
                        request);
            }
            finally
            {
                request.remove("Secret");
            }
            secret = "";
            SessionPayload session = createSession(serverUrl, publicInfo, authentication);
            if (operation == generation)
            {
                callback.onAuthenticated(operation, session, persist);
            }
        }
        catch (InterruptedException ignored)
        {
            Thread.currentThread().interrupt();
        }
        catch (Exception exception)
        {
            if (operation == generation)
            {
                callback.onError(operation, friendlyError(exception));
            }
        }
    }

    private SessionPayload createSession(
            String serverUrl,
            JSONObject publicInfo,
            JSONObject authentication) throws Exception
    {
        JSONObject user = authentication.optJSONObject("User");
        String accessToken = stringValue(authentication, "AccessToken").trim();
        String userId = user == null ? "" : stringValue(user, "Id").trim();
        SessionPayload session = SessionPayload.create(
                serverUrl,
                stringValue(publicInfo, "ServerName"),
                stringValue(publicInfo, "Version"),
                firstNonEmpty(
                        stringValue(authentication, "ServerId"),
                        stringValue(publicInfo, "Id")),
                accessToken,
                userId,
                user == null ? "" : stringValue(user, "Name"),
                sessions.getOrCreateDeviceId());
        if (session == null)
        {
            throw new UserVisibleException("服务器没有返回有效的 Jellyfin 会话。");
        }
        return session;
    }

    private String requestText(String method, String endpoint, JSONObject body) throws Exception
    {
        HttpURLConnection connection = null;
        try
        {
            connection = (HttpURLConnection) new URL(endpoint).openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(HTTP_TIMEOUT_MS);
            connection.setReadTimeout(HTTP_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            String authorization = authorizationHeader();
            connection.setRequestProperty("Authorization", authorization);

            if (body != null)
            {
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                try
                {
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(payload.length);
                    connection.setRequestProperty(
                            "Content-Type",
                            "application/json; charset=utf-8");
                    try (OutputStream output = connection.getOutputStream())
                    {
                        output.write(payload);
                    }
                }
                finally
                {
                    Arrays.fill(payload, (byte) 0);
                }
            }

            int statusCode = connection.getResponseCode();
            InputStream stream = statusCode >= 200 && statusCode < 300
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String response = readStream(stream);
            if (statusCode < 200 || statusCode >= 300)
            {
                throw new HttpFailure(statusCode);
            }
            return response;
        }
        finally
        {
            if (connection != null)
            {
                connection.disconnect();
            }
        }
    }

    private JSONObject requestJson(String method, String endpoint, JSONObject body) throws Exception
    {
        String response = requestText(method, endpoint, body);
        return response.trim().isEmpty() ? new JSONObject() : new JSONObject(response);
    }

    private static String readStream(InputStream stream) throws Exception
    {
        if (stream == null)
        {
            return "";
        }
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8)))
        {
            StringBuilder result = new StringBuilder();
            char[] buffer = new char[4_096];
            int read;
            while ((read = reader.read(buffer)) >= 0)
            {
                if (result.length() + read > MAX_RESPONSE_LENGTH)
                {
                    throw new UserVisibleException("Jellyfin 响应过大，已停止处理。");
                }
                result.append(buffer, 0, read);
            }
            return result.toString();
        }
    }

    private String authorizationHeader()
    {
        return "MediaBrowser Client=\"tachi\", Device=\""
                + deviceName
                + "\", DeviceId=\""
                + headerSafe(sessions.getOrCreateDeviceId())
                + "\", Version=\""
                + headerSafe(BuildConfig.VERSION_NAME)
                + "\"";
    }

    private static String friendlyError(Exception exception)
    {
        if (exception instanceof UserVisibleException)
        {
            return exception.getMessage();
        }
        if (exception instanceof HttpFailure)
        {
            int statusCode = ((HttpFailure) exception).statusCode;
            if (statusCode == 401 || statusCode == 403)
            {
                return "用户名或密码不正确，请检查后重试。";
            }
            if (statusCode == 404)
            {
                return "服务器不支持此登录方式，请检查地址或改用账户密码。";
            }
            return "Jellyfin 请求失败（HTTP " + statusCode + "），请检查服务器。";
        }
        if (exception instanceof SocketTimeoutException)
        {
            return "连接 Jellyfin 超时，请确认手机与服务器在同一网络。";
        }
        if (exception instanceof java.net.UnknownHostException)
        {
            return "找不到 Jellyfin 服务器，请检查地址。";
        }
        if (exception instanceof ConnectException)
        {
            return "无法连接 Jellyfin，请检查地址、端口和局域网。";
        }
        if (exception instanceof SSLException)
        {
            return "HTTPS 证书验证失败，请检查服务器证书。";
        }
        return "Jellyfin 登录失败，请检查服务器地址后重试。";
    }

    private static String headerSafe(String value)
    {
        return value == null
                ? ""
                : value.replace("\\", "")
                        .replace("\"", "")
                        .replace("\n", "")
                        .replace("\r", "");
    }

    private static String bounded(String value, int maximumLength)
    {
        if (value == null)
        {
            return "";
        }
        return value.length() <= maximumLength ? value : value.substring(0, maximumLength);
    }

    private static String firstNonEmpty(String first, String second)
    {
        return first == null || first.trim().isEmpty() ? second : first;
    }

    private static String stringValue(JSONObject source, String key)
    {
        Object value = source == null ? null : source.opt(key);
        return value instanceof String ? (String) value : "";
    }

    private static final class HttpFailure extends Exception
    {
        final int statusCode;

        HttpFailure(int statusCode)
        {
            super("HTTP " + statusCode);
            this.statusCode = statusCode;
        }
    }

    private static final class UserVisibleException extends Exception
    {
        UserVisibleException(String message)
        {
            super(message);
        }
    }
}
