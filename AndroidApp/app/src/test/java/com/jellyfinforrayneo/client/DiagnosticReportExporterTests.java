package com.jellyfinforrayneo.client;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class DiagnosticReportExporterTests
{
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void sharesCompleteUtf8ReportsWithUniqueNamesAndBoundedRetention() throws Exception
    {
        File directory = new File(folder.getRoot(), "diagnostics");
        String report = "tachi 诊断\n" + "nativePlayback={\"status\":\"paused\"}\n".repeat(120);
        File first = DiagnosticReportExporter.save(directory, report);
        File second = DiagnosticReportExporter.save(directory, report);
        assertNotEquals(first, second);
        assertEquals(report, new String(Files.readAllBytes(second.toPath()), StandardCharsets.UTF_8));
        for (int index = 0; index < 8; index++) DiagnosticReportExporter.save(directory, report);
        assertEquals(3, directory.listFiles().length);
    }

    @Test
    public void refusesOversizedReportsBeforeCreatingFiles() throws Exception
    {
        File directory = new File(folder.getRoot(), "diagnostics");
        try
        {
            DiagnosticReportExporter.save(directory, "x".repeat(512 * 1024 + 1));
            fail("Expected a bounded report");
        }
        catch (IllegalArgumentException expected) { assertFalse(directory.exists()); }
    }
}
