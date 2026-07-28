package xyz.block.buzz.mobile

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AgentLiveUpdatePayloadTest {
    @Test
    fun `parses Flutter method channel values`() {
        val payload = AgentLiveUpdatePayload.from(
            mapOf(
                "title" to "Agent is working",
                "body" to "Working in #agents",
                "activeCount" to 1,
                "startedAtMillis" to 1_722_081_600_000L,
                "timeoutAfterMillis" to 30_000,
                "channelId" to "channel-1",
                "messageId" to "message-1",
            ),
        )

        requireNotNull(payload)
        assertEquals("Agent is working", payload.title)
        assertEquals("Working in #agents", payload.body)
        assertEquals(1, payload.activeCount)
        assertEquals(1_722_081_600_000L, payload.startedAtMillis)
        assertEquals(30_000L, payload.timeoutAfterMillis)
        assertEquals("channel-1", payload.channelId)
        assertEquals("message-1", payload.messageId)
    }

    @Test
    fun `rejects missing or invalid required values`() {
        assertNull(AgentLiveUpdatePayload.from(null))
        assertNull(
            AgentLiveUpdatePayload.from(
                mapOf(
                    "title" to "",
                    "body" to "Working in #agents",
                    "activeCount" to 0,
                    "startedAtMillis" to 1L,
                    "timeoutAfterMillis" to 30_000,
                    "channelId" to "channel-1",
                ),
            ),
        )
    }
}
