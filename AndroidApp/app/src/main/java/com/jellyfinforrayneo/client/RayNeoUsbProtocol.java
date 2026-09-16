package com.jellyfinforrayneo.client;

/** Air 3s display-only HID reports; see docs/SBS_GEOMETRY.md for provenance. */
final class RayNeoUsbProtocol
{
    static final int REPORT_SIZE = 64;
    static final int VENDOR_ID = 0x1bbb;
    static final int PRODUCT_ID = 0xaf50;

    private RayNeoUsbProtocol()
    {
    }

    static boolean supports(int vendorId, int productId)
    {
        return vendorId == VENDOR_ID && productId == PRODUCT_ID;
    }

    static byte[] displayMode(boolean stereo)
    {
        byte[] report = new byte[REPORT_SIZE];
        report[0] = 0x66;
        report[1] = (byte) (stereo ? 6 : 7);
        return report;
    }
}
