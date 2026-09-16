package com.jellyfinforrayneo.client;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.hardware.usb.UsbRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.nio.ByteBuffer;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Owns only a short USB display command, never another app or its service. */
final class RayNeoUsbDisplayClient
{
    interface Listener
    {
        void onCommandWritten();

        void onPermissionRequired();

        void onPermissionResult(boolean granted);

        void onUnavailable();
    }

    private final Context context;
    private final UsbManager usb;
    private final Listener listener;
    private final String permissionAction;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(
            1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(1),
            runnable -> new Thread(runnable, "rayneo-usb-display"),
            new ThreadPoolExecutor.DiscardOldestPolicy());
    private final BroadcastReceiver permissionReceiver = new BroadcastReceiver()
    {
        @Override
        public void onReceive(Context ignoredContext, Intent intent)
        {
            if (destroyed || intent == null || !permissionAction.equals(intent.getAction())
                    || !permissionPending)
            {
                return;
            }
            permissionPending = false;
            UsbDevice device = findDevice();
            // Read the actual grant from UsbManager, never trust broadcast extras.
            boolean granted = device != null && device.getDeviceId() == permissionDeviceId
                    && usb.hasPermission(device);
            permissionDeviceId = -1;
            listener.onPermissionResult(granted);
        }
    };

    private boolean permissionPending;
    private int permissionDeviceId = -1;
    private volatile boolean destroyed;
    private volatile long generation;

    RayNeoUsbDisplayClient(Context context, Listener listener)
    {
        this.context = context;
        this.listener = listener;
        usb = (UsbManager) context.getSystemService(Context.USB_SERVICE);
        permissionAction = context.getPackageName() + ".USB_DISPLAY_PERMISSION";
        IntentFilter filter = new IntentFilter(permissionAction);
        if (Build.VERSION.SDK_INT >= 33)
        {
            context.registerReceiver(permissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        }
        else
        {
            context.registerReceiver(permissionReceiver, filter);
        }
    }

    boolean isPermissionPending()
    {
        return permissionPending;
    }

    void cancelPendingCommand()
    {
        ++generation;
    }

    void request(boolean stereo, boolean allowPermission)
    {
        if (destroyed)
        {
            return;
        }
        final long requestGeneration = ++generation;
        UsbDevice device = findDevice();
        if (device == null)
        {
            if (allowPermission)
            {
                listener.onUnavailable();
            }
            return;
        }
        if (!usb.hasPermission(device))
        {
            if (allowPermission && !permissionPending)
            {
                permissionPending = true;
                permissionDeviceId = device.getDeviceId();
                listener.onPermissionRequired();
                try
                {
                    PendingIntent result = PendingIntent.getBroadcast(context, 0,
                            new Intent(permissionAction).setPackage(context.getPackageName()),
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                    usb.requestPermission(device, result);
                }
                catch (RuntimeException exception)
                {
                    permissionPending = false;
                    permissionDeviceId = -1;
                    listener.onPermissionResult(false);
                }
            }
            return;
        }
        worker.execute(() ->
        {
            if (destroyed || requestGeneration != generation)
            {
                return;
            }
            boolean written = send(device, stereo, requestGeneration);
            handler.post(() ->
            {
                if (!destroyed && requestGeneration == generation)
                {
                    if (written)
                    {
                        listener.onCommandWritten();
                    }
                    else if (allowPermission)
                    {
                        listener.onUnavailable();
                    }
                }
            });
        });
    }

    private UsbDevice findDevice()
    {
        if (usb == null)
        {
            return null;
        }
        for (UsbDevice device : usb.getDeviceList().values())
        {
            if (RayNeoUsbProtocol.supports(device.getVendorId(), device.getProductId())
                    && findControlInterface(device) != null)
            {
                return device;
            }
        }
        return null;
    }

    private static UsbInterface findControlInterface(UsbDevice device)
    {
        for (int index = 0; index < device.getInterfaceCount(); index++)
        {
            UsbInterface candidate = device.getInterface(index);
            if (candidate.getId() != 0 || candidate.getAlternateSetting() != 0
                    || candidate.getInterfaceClass() != UsbConstants.USB_CLASS_HID
                    || candidate.getInterfaceSubclass() != 0 || candidate.getInterfaceProtocol() != 0)
            {
                continue;
            }
            boolean input = false;
            boolean output = false;
            for (int endpointIndex = 0; endpointIndex < candidate.getEndpointCount(); endpointIndex++)
            {
                UsbEndpoint endpoint = candidate.getEndpoint(endpointIndex);
                if (endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_INT
                        && endpoint.getMaxPacketSize() == RayNeoUsbProtocol.REPORT_SIZE)
                {
                    input |= endpoint.getAddress() == 0x81;
                    output |= endpoint.getAddress() == 0x01;
                }
            }
            if (input && output)
            {
                return candidate;
            }
        }
        return null;
    }

    private boolean send(UsbDevice device, boolean stereo, long requestGeneration)
    {
        UsbDeviceConnection connection = null;
        UsbInterface control = findControlInterface(device);
        UsbRequest transfer = null;
        boolean claimed = false;
        try
        {
            if (control == null || !usb.hasPermission(device) || requestGeneration != generation)
            {
                return false;
            }
            connection = usb.openDevice(device);
            if (connection == null || !connection.claimInterface(control, true))
            {
                return false;
            }
            claimed = true;
            UsbEndpoint output = null;
            for (int index = 0; index < control.getEndpointCount(); index++)
            {
                if (control.getEndpoint(index).getAddress() == 0x01)
                {
                    output = control.getEndpoint(index);
                }
            }
            if (requestGeneration != generation)
            {
                return false;
            }
            transfer = new UsbRequest();
            ByteBuffer buffer = ByteBuffer.allocateDirect(RayNeoUsbProtocol.REPORT_SIZE);
            buffer.put(RayNeoUsbProtocol.displayMode(stereo));
            buffer.flip();
            if (output == null || !transfer.initialize(connection, output) || !transfer.queue(buffer))
            {
                return false;
            }
            // UsbRequest supports interrupt endpoints without blocking the UI thread.
            return connection.requestWait(750L) == transfer
                    && buffer.position() == RayNeoUsbProtocol.REPORT_SIZE;
        }
        catch (Exception exception)
        {
            Log.w("RayNeoDisplay", "USB display command unavailable: "
                    + exception.getClass().getSimpleName());
            return false;
        }
        finally
        {
            if (transfer != null)
            {
                transfer.cancel();
                transfer.close();
            }
            if (connection != null)
            {
                if (claimed)
                {
                    connection.releaseInterface(control);
                }
                connection.close();
            }
        }
    }

    void destroy(boolean restoreMirror)
    {
        destroyed = true;
        final long requestGeneration = ++generation;
        context.unregisterReceiver(permissionReceiver);
        worker.execute(() ->
        {
            UsbDevice device = restoreMirror ? findDevice() : null;
            if (device != null && usb.hasPermission(device))
            {
                send(device, false, requestGeneration);
            }
        });
        worker.shutdown();
    }
}
