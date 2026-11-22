package com.tarobot.client;

import java.io.*;
import java.util.ArrayList;
import java.util.List;
import org.json.*;

/** Published shares keep their import lifetime when delivery metadata changes. */
final class ShareInboxExpiry {
    private static final int MAX_ITEM_BYTES = 1024 * 1024;
    private static final long SAFE_INTEGER = 9007199254740991L;

    static JSONObject readItem(File directory) throws IOException, JSONException {
        File file = new File(directory, "item.json");
        if (file.length() > MAX_ITEM_BYTES) throw new IOException("share_item_invalid");
        try (InputStream input = new FileInputStream(file); ByteArrayOutputStream data = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (data.size() + count > MAX_ITEM_BYTES) throw new IOException("share_item_invalid");
                data.write(buffer, 0, count);
            }
            return new JSONObject(data.toString("UTF-8"));
        }
    }

    /**
     * The items a listing can show, in the given order. An entry whose manifest cannot be read (cut short, not an
     * object, oversized) or whose folder is not an item id is left out, so that it cannot hide the others; it stays
     * on disk and ages out as before. An entry still being imported has no item.json yet and is left out as well.
     */
    static List<JSONObject> readableItems(File[] directories) {
        List<JSONObject> items = new ArrayList<>();
        for (File directory : directories) {
            if (!directory.getName().matches("[a-f0-9-]{36}") || !new File(directory, "item.json").isFile()) continue;
            try { items.add(readItem(directory)); } catch (IOException | JSONException unreadable) { /* Left out; see above. */ }
        }
        return items;
    }

    static boolean isExpired(File directory, long now, long ttl) {
        long createdAt = directory.lastModified();
        try {
            Object value = readItem(directory).opt("createdAt");
            if (value instanceof Number) {
                double number = ((Number) value).doubleValue();
                if (Double.isFinite(number) && number > 0 && number <= SAFE_INTEGER
                        && number <= now && Math.rint(number) == number) {
                    createdAt = ((Number) value).longValue();
                }
            }
        } catch (IOException | JSONException ignored) {
            // Interrupted imports and malformed records retain their existing age-based cleanup.
        }
        return now - createdAt > ttl;
    }
}
