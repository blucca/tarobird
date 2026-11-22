package com.tarobot.client;

import static org.junit.Assert.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.*;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ShareInboxExpiryTest {
    private static final long HOUR = 3600_000L, TTL = 24 * HOUR, NOW = 1_800_000_000_000L;
    @Rule public TemporaryFolder temp = new TemporaryFolder();

    private File item(Object createdAt, long modifiedAt) throws Exception {
        File directory = temp.newFolder();
        JSONObject item = new JSONObject().put("id", directory.getName()).put("text", "shared text").put("files", new JSONArray());
        if (createdAt != null) item.put("createdAt", createdAt);
        publish(directory, item);
        assertTrue(directory.setLastModified(modifiedAt));
        return directory;
    }

    private void publish(File directory, JSONObject item) throws Exception {
        File staging = new File(directory, "item.tmp");
        try (FileOutputStream output = new FileOutputStream(staging)) {
            output.write(item.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        assertTrue(staging.renameTo(new File(directory, "item.json")));
    }

    @Test public void pinningRecipientAfterTwentyThreeHoursDoesNotRestartRetention() throws Exception {
        long now = System.currentTimeMillis(), importedAt = now - 25 * HOUR, attemptedAt = importedAt + 23 * HOUR;
        File directory = item(importedAt, importedAt);
        assertFalse(ShareInboxExpiry.isExpired(directory, attemptedAt, TTL));
        JSONObject pinned = ShareInboxExpiry.readItem(directory).put("delivery", new JSONObject()
            .put("hubKey", "host").put("deviceId", "device").put("conversationId", "chat").put("text", "edited text"));
        publish(directory, pinned);
        assertTrue("Atomic publication must change the directory mtime", directory.lastModified() > importedAt);
        assertTrue(directory.setLastModified(attemptedAt));
        assertTrue("A failed first send must not retain the share beyond its import lifetime", ShareInboxExpiry.isExpired(directory, now, TTL));
        assertEquals(importedAt, ShareInboxExpiry.readItem(directory).getLong("createdAt"));
        assertEquals("chat", ShareInboxExpiry.readItem(directory).getJSONObject("delivery").getString("conversationId"));
    }

    @Test public void publishedTimestampPreservesTheExistingTwentyFourHourBoundary() throws Exception {
        File directory = item(NOW - TTL, NOW);
        assertFalse(ShareInboxExpiry.isExpired(directory, NOW, TTL));
        assertTrue(ShareInboxExpiry.isExpired(directory, NOW + 1, TTL));
    }

    @Test public void freshPublishedItemSurvivesAnOlderDirectoryTimestamp() throws Exception {
        assertFalse(ShareInboxExpiry.isExpired(item(NOW - HOUR, NOW - 2 * TTL), NOW, TTL));
    }

    @Test public void invalidAndFutureCreationTimesKeepTheDirectoryCleanupFallback() throws Exception {
        for (Object invalid : new Object[]{null, JSONObject.NULL, "1", true, 0, -1, 1.5, NOW + HOUR, Long.MAX_VALUE}) {
            assertTrue("Old invalid timestamp: " + invalid, ShareInboxExpiry.isExpired(item(invalid, NOW - TTL - 1), NOW, TTL));
            assertFalse("Recent invalid timestamp: " + invalid, ShareInboxExpiry.isExpired(item(invalid, NOW - HOUR), NOW, TTL));
        }
    }

    @Test public void unpublishedAndCorruptManifestsStillAgeOut() throws Exception {
        for (String content : new String[]{null, "{unfinished", "[]", " ".repeat(1024 * 1024 + 1)}) {
            File directory = temp.newFolder();
            if (content != null) Files.writeString(new File(directory, "item.json").toPath(), content);
            else Files.writeString(new File(directory, "item.tmp").toPath(), "unpublished");
            assertTrue(directory.setLastModified(NOW - HOUR));
            assertFalse(ShareInboxExpiry.isExpired(directory, NOW, TTL));
            assertTrue(directory.setLastModified(NOW - TTL - 1));
            assertTrue(ShareInboxExpiry.isExpired(directory, NOW, TTL));
        }
    }

    @Test public void oneUnreadableEntryDoesNotHideTheOthers() throws Exception {
        File first = temp.newFolder("11111111-1111-4111-8111-111111111111"), second = temp.newFolder("33333333-3333-4333-8333-333333333333");
        publish(first, new JSONObject().put("id", first.getName()).put("text", "first").put("files", new JSONArray()));
        publish(second, new JSONObject().put("id", second.getName()).put("text", "second").put("files", new JSONArray()));
        File cutShort = temp.newFolder("22222222-2222-4222-8222-222222222222"), notAnObject = temp.newFolder("44444444-4444-4444-8444-444444444444");
        File oversized = temp.newFolder("55555555-5555-4555-8555-555555555555"), importing = temp.newFolder("66666666-6666-4666-8666-666666666666");
        Files.writeString(new File(cutShort, "item.json").toPath(), "{\"id\":\"22222222-2222-4222-8222-22222222");
        Files.writeString(new File(notAnObject, "item.json").toPath(), "[]");
        Files.write(new File(oversized, "item.json").toPath(), new byte[1024 * 1024 + 1]);
        Files.writeString(new File(importing, "item.tmp").toPath(), "unpublished");
        File stray = temp.newFolder("not-an-item-id");
        publish(stray, new JSONObject().put("id", "not-an-item-id").put("text", "stray").put("files", new JSONArray()));
        java.util.List<JSONObject> items = ShareInboxExpiry.readableItems(new File[]{first, cutShort, second, notAnObject, oversized, importing, stray});
        assertEquals(2, items.size());
        assertEquals("first", items.get(0).getString("text"));
        assertEquals("second", items.get(1).getString("text"));
        // The unreadable entries are left where they are; the age-based cleanup still owns them.
        for (File left : new File[]{cutShort, notAnObject, oversized, importing, stray}) assertTrue(left.isDirectory());
    }

    @Test public void oversizedManifestsStillRejectNormalReads() throws Exception {
        File directory = temp.newFolder();
        Files.write(new File(directory, "item.json").toPath(), new byte[1024 * 1024 + 1]);
        assertThrows(IOException.class, () -> ShareInboxExpiry.readItem(directory));
    }
}
