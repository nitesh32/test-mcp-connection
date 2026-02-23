// mcp-load-test.js
import EventSource from "eventsource";
import fetch from "node-fetch";

// const MCP_URL = "http://3.92.23.226:8080/mcp";
const MCP_URL = "http://localhost:3100/mcp";
const ACCESS_TOKEN = "mcp_ea19ab716b3d36e6fe12e1390d5dfe1e4590875aebb1b4a9";

// Set to true for detailed request/response logging (useful for debugging)
const VERBOSE_LOGGING = false;

class MCPClient {
  constructor(clientId) {
    this.clientId = clientId;
    this.messageId = 0;
    this.eventSource = null;
    this.sessionId = null;
    this.metrics = {
      connected: false,
      toolCallsSuccess: 0,
      toolCallsFailed: 0,
      errors: 0,
    };
  }

  async createSession() {
    try {
      const requestUrl = `${MCP_URL}?access_token=${ACCESS_TOKEN}`;
      const requestBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: `load-test-client-${this.clientId}`,
            version: "1.0.0",
          },
        },
      };

      if (VERBOSE_LOGGING) {
        console.log(
          `[Client ${this.clientId}] 📤 Sending initialize request to: ${requestUrl}`,
        );
        console.log(
          `[Client ${this.clientId}] 📤 Request body:`,
          JSON.stringify(requestBody, null, 2),
        );
      }

      // First, create a session via POST
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(requestBody),
      });

      if (VERBOSE_LOGGING) {
        console.log(
          `[Client ${this.clientId}] 📥 Response status: ${response.status} ${response.statusText}`,
        );
        console.log(`[Client ${this.clientId}] 📥 Response headers:`);
        for (const [key, value] of response.headers.entries()) {
          console.log(`    ${key}: ${value}`);
        }
      }

      // Extract session ID from header first (this is the primary source)
      const headerSessionId = response.headers.get("mcp-session-id");

      // Get raw response text for debugging
      const rawText = await response.text();

      if (VERBOSE_LOGGING) {
        console.log(
          `[Client ${this.clientId}] 🔍 Header 'mcp-session-id':`,
          headerSessionId,
        );
        console.log(
          `[Client ${this.clientId}] 📥 Raw response body (first 500 chars):`,
          rawText.substring(0, 500),
        );
      }

      // Check content type to determine how to parse
      const contentType = response.headers.get("content-type") || "";

      // Parse response body - handle both JSON and SSE formats
      let data = null;
      if (contentType.includes("text/event-stream")) {
        // SSE format: extract JSON from "data: {...}" lines
        const dataMatch = rawText.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            data = JSON.parse(dataMatch[1]);
          } catch (parseErr) {
            console.error(
              `[Client ${this.clientId}] ⚠️ SSE JSON parse error:`,
              parseErr.message,
            );
          }
        }
      } else {
        // Regular JSON format
        try {
          data = JSON.parse(rawText);
        } catch (parseErr) {
          console.error(
            `[Client ${this.clientId}] ⚠️ JSON parse error:`,
            parseErr.message,
          );
        }
      }

      // Extract sessionId - header is primary, body is fallback
      this.sessionId =
        headerSessionId ||
        data?.sessionId ||
        data?.result?.sessionId ||
        data?.result?._meta?.sessionId;

      if (!this.sessionId) {
        console.error(
          `[Client ${this.clientId}] ❌ Could not find session ID in any expected location`,
        );
        if (data) {
          console.error(
            `[Client ${this.clientId}] 📋 Full data keys:`,
            Object.keys(data),
          );
          if (data.result) {
            console.error(
              `[Client ${this.clientId}] 📋 Result keys:`,
              Object.keys(data.result),
            );
          }
        }
        throw new Error("No session ID received");
      }

      console.log(
        `[Client ${this.clientId}] ✅ Session created: ${this.sessionId}`,
      );
      return this.sessionId;
    } catch (err) {
      console.error(
        `[Client ${this.clientId}] ❌ Failed to create session:`,
        err.message,
      );
      throw err;
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!this.sessionId) {
        console.error(
          `[Client ${this.clientId}] ❌ Cannot connect SSE: No session ID`,
        );
        reject(new Error("Session must be created first"));
        return;
      }

      // Connect to SSE with the sessionId in headers
      // Note: eventsource library supports headers via options
      const url = `${MCP_URL}?access_token=${ACCESS_TOKEN}`;
      const eventSourceInitDict = {
        headers: {
          "mcp-session-id": this.sessionId,
        },
      };
      if (VERBOSE_LOGGING) {
        console.log(`[Client ${this.clientId}] 🔌 Connecting SSE to: ${url}`);
      }

      this.eventSource = new EventSource(url, eventSourceInitDict);

      this.eventSource.onopen = () => {
        this.metrics.connected = true;
        resolve();
      };

      this.eventSource.addEventListener("message", (event) => {
        if (VERBOSE_LOGGING) {
          console.log(
            `[Client ${this.clientId}] 📨 SSE message received:`,
            event.data?.substring(0, 100),
          );
        }
        try {
          const response = JSON.parse(event.data);
          if (response.error) {
            console.error(
              `[Client ${this.clientId}] ❌ SSE error response:`,
              response.error,
            );
          }
        } catch (err) {
          this.metrics.errors++;
        }
      });

      this.eventSource.onerror = (error) => {
        if (VERBOSE_LOGGING) {
          console.error(`[Client ${this.clientId}] ❌ SSE error event:`, {
            message: error?.message,
            readyState: this.eventSource?.readyState,
          });
        }
        this.metrics.errors++;
      };

      // Timeout if connection doesn't open
      setTimeout(() => {
        if (!this.metrics.connected) {
          if (VERBOSE_LOGGING) {
            console.error(
              `[Client ${this.clientId}] ⏱️ SSE connection timeout`,
            );
          }
          reject(new Error("SSE connection timeout"));
        }
      }, 10000);
    });
  }

  async sendRequest(method, params = {}) {
    if (!this.sessionId) {
      console.error(
        `[Client ${this.clientId}] ❌ sendRequest failed: No session established`,
      );
      throw new Error("No session established");
    }

    const message = {
      jsonrpc: "2.0",
      id: ++this.messageId,
      method,
      params,
    };

    const requestUrl = `${MCP_URL}?access_token=${ACCESS_TOKEN}`;

    if (VERBOSE_LOGGING) {
      console.log(
        `[Client ${this.clientId}] 📤 sendRequest: ${method} (id: ${message.id})`,
      );
    }

    try {
      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": this.sessionId,
        },
        body: JSON.stringify(message),
      });

      const rawText = await response.text();

      if (VERBOSE_LOGGING) {
        console.log(
          `[Client ${this.clientId}] 📥 Response status: ${response.status}`,
        );
      }

      if (!response.ok) {
        this.metrics.toolCallsFailed++;
        throw new Error(`HTTP ${response.status}: ${rawText}`);
      }

      // Check content type to determine how to parse
      const contentType = response.headers.get("content-type") || "";

      let result;
      if (contentType.includes("text/event-stream")) {
        // SSE format: extract JSON from "data: {...}" lines
        const dataMatch = rawText.match(/^data: (.+)$/m);
        if (dataMatch) {
          try {
            result = JSON.parse(dataMatch[1]);
          } catch (parseErr) {
            console.error(
              `[Client ${this.clientId}] ❌ SSE JSON parse error:`,
              parseErr.message,
            );
            throw parseErr;
          }
        } else {
          throw new Error("Could not extract data from SSE response");
        }
      } else {
        // Regular JSON format
        try {
          result = JSON.parse(rawText);
        } catch (parseErr) {
          if (VERBOSE_LOGGING) {
            console.error(
              `[Client ${this.clientId}] ❌ JSON parse error:`,
              parseErr.message,
            );
          }
          throw parseErr;
        }
      }

      this.metrics.toolCallsSuccess++;
      return result;
    } catch (err) {
      if (VERBOSE_LOGGING) {
        console.error(
          `[Client ${this.clientId}] ❌ sendRequest error:`,
          err.message,
        );
      }
      this.metrics.toolCallsFailed++;
      throw err;
    }
  }

  async initialize() {
    return this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: `load-test-client-${this.clientId}`,
        version: "1.0.0",
      },
    });
  }

  async listTools() {
    return this.sendRequest("tools/list");
  }

  async callTool(toolName, args = {}) {
    return this.sendRequest("tools/call", {
      name: toolName,
      arguments: args,
    });
  }

  disconnect() {
    if (this.eventSource) {
      this.eventSource.close();
      this.metrics.connected = false;
    }
  }
}

// Load test configuration
const TEST_CONFIG = {
  numClients: 200, // 100 concurrent clients
  duration: 10000, // 10 seconds
  toolCallInterval: 1000, // Each client makes a call every 2 seconds
  verboseLogging: false, // Set to true for detailed logs during tool calls
};

async function runLoadTest() {
  console.log(`\n🚀 Starting MCP Load Test`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`   MCP URL: ${MCP_URL}`);
  console.log(`   Access Token: ${ACCESS_TOKEN.substring(0, 10)}...`);
  console.log(`   Clients: ${TEST_CONFIG.numClients}`);
  console.log(`   Duration: ${TEST_CONFIG.duration / 1000}s`);
  console.log(`   Tool call interval: ${TEST_CONFIG.toolCallInterval}ms`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const startTime = Date.now();

  // Create and connect clients IN PARALLEL
  console.log(
    `\n🔌 Connecting ${TEST_CONFIG.numClients} clients in parallel...\n`,
  );

  const setupClient = async (clientId) => {
    const client = new MCPClient(clientId);
    try {
      await client.createSession();
      await client.connect();
      console.log(`[Client ${clientId}] ✅ Ready`);
      return client;
    } catch (err) {
      console.error(`[Client ${clientId}] ❌ Failed:`, err.message);
      return client; // Return anyway to track failed clients
    }
  };

  // Launch all connections simultaneously
  const setupPromises = Array.from({ length: TEST_CONFIG.numClients }, (_, i) =>
    setupClient(i + 1),
  );

  const clients = await Promise.all(setupPromises);
  const connectedCount = clients.filter((c) => c.metrics.connected).length;

  console.log(
    `\n✅ Setup complete: ${connectedCount}/${TEST_CONFIG.numClients} clients connected`,
  );
  console.log(
    `   Setup time: ${((Date.now() - startTime) / 1000).toFixed(2)}s\n`,
  );

  console.log(`\n🎯 Starting tool calls...\n`);

  // Progress tracking
  const progressInterval = 5000; // Print progress every 5 seconds

  // Simulate continuous tool calls
  const intervals = clients.map((client) => {
    return setInterval(async () => {
      if (!client.metrics.connected) return;

      try {
        // Call fetch_repo_graph tool
        // await client.callTool("fetch_repo_graph", { queryType: "SUMMARY_ORG" });
        await client.callTool("server_info", {});
        if (TEST_CONFIG.verboseLogging) {
          console.log(
            `[Client ${client.clientId}] ✅ Tool call ${client.metrics.toolCallsSuccess}`,
          );
        }
      } catch (err) {
        // Always log errors
        console.error(
          `[Client ${client.clientId}] ❌ Tool call failed:`,
          err.message,
        );
      }
    }, TEST_CONFIG.toolCallInterval);
  });

  // Progress reporter
  const progressReporter = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const totalSuccess = clients.reduce(
      (sum, c) => sum + c.metrics.toolCallsSuccess,
      0,
    );
    const totalFailed = clients.reduce(
      (sum, c) => sum + c.metrics.toolCallsFailed,
      0,
    );
    const connectedNow = clients.filter((c) => c.metrics.connected).length;
    console.log(
      `📊 [${elapsed}s] Connected: ${connectedNow} | Success: ${totalSuccess} | Failed: ${totalFailed} | Rate: ${(totalSuccess / Number(elapsed)).toFixed(1)}/s`,
    );
  }, progressInterval);

  // Wait for test duration
  await new Promise((resolve) => setTimeout(resolve, TEST_CONFIG.duration));

  // Cleanup
  console.log(`\n🛑 Stopping test...\n`);
  clearInterval(progressReporter);
  intervals.forEach((interval) => clearInterval(interval));
  clients.forEach((client) => client.disconnect());

  // Report results
  const totalTime = (Date.now() - startTime) / 1000;
  const totalSuccess = clients.reduce(
    (sum, c) => sum + c.metrics.toolCallsSuccess,
    0,
  );
  const totalFailed = clients.reduce(
    (sum, c) => sum + c.metrics.toolCallsFailed,
    0,
  );
  const totalErrors = clients.reduce((sum, c) => sum + c.metrics.errors, 0);
  const connectedClients = clients.filter((c) => c.sessionId).length;

  console.log(`📊 Load Test Results`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`   Duration: ${totalTime.toFixed(2)}s`);
  console.log(
    `   Connected clients: ${connectedClients}/${TEST_CONFIG.numClients}`,
  );
  console.log(`   Total tool calls: ${totalSuccess + totalFailed}`);
  console.log(`   ✅ Successful: ${totalSuccess}`);
  console.log(`   ❌ Failed: ${totalFailed}`);
  console.log(`   ⚠️  Errors: ${totalErrors}`);

  if (totalSuccess + totalFailed > 0) {
    console.log(
      `   📈 Success rate: ${((totalSuccess / (totalSuccess + totalFailed)) * 100).toFixed(2)}%`,
    );
    console.log(
      `   ⚡ Throughput: ${(totalSuccess / totalTime).toFixed(2)} calls/sec`,
    );
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  process.exit(0);
}

runLoadTest().catch(console.error);
