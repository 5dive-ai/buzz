#if DEBUG
  import CryptoKit
  import Foundation
  #if canImport(FoundationNetworking)
    import FoundationNetworking
  #endif
  import XCTest

  @testable import BuzzPushKit

  final class BuzzDevPushEnrollmentDriverTests: XCTestCase {
    private static let gatewayURL = URL(string: "http://push.example/")!
    private static let relayURL = URL(string: "wss://relay.example/")!
    private static let relayPubkey = String(repeating: "a", count: 64)
    private static let firstChallengeId = "11111111-1111-4111-8111-111111111111"
    private static let secondChallengeId = "33333333-3333-4333-8333-333333333333"
    private static let installationHandle = "22222222-2222-4222-8222-222222222222"
    private static let challenge = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    private static let now: Int64 = 1_752_620_000
    private static let expiresAt: Int64 = 1_752_624_000
    private static let endpoint =
      "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
    fileprivate static let keyId = "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo="
    fileprivate static let attestation = Data("test-attestation".utf8).base64EncodedString()
    fileprivate static let assertion = Data("buzz-dev-app-assertion-v1".utf8).base64EncodedString()

    override func setUp() {
      super.setUp()
      URLProtocolStub.reset()
    }

    override func tearDown() {
      URLProtocolStub.reset()
      super.tearDown()
    }

    func testEnrollmentPinsTranscriptsAndPersistsOpaqueGrant() async throws {
      let store = MemoryGrantStore()
      let appAttest = RecordingAppAttest()
      let driver = try makeDriver(store: store, appAttest: appAttest)
      var challengeCount = 0
      URLProtocolStub.handler = { request in
        switch (request.httpMethod, request.url?.absoluteString) {
        case ("GET", "https://relay.example/"):
          XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/nostr+json")
          return Self.response(
            request,
            status: 200,
            json: [
              "push": [
                "keys": [
                  ["id": "current", "pubkey": Self.relayPubkey, "current": true]
                ]
              ]
            ]
          )
        case ("POST", "http://push.example/v1/installations/challenges"):
          challengeCount += 1
          let body = try Self.body(request)
          XCTAssertEqual(body["v"] as? Int, 1)
          XCTAssertEqual(body.count, 1)
          let id = challengeCount == 1 ? Self.firstChallengeId : Self.secondChallengeId
          return Self.response(
            request,
            status: 200,
            json: [
              "challenge_id": id,
              "challenge": Self.challenge,
              "expires_at": Self.now + 300,
            ]
          )
        case ("POST", "http://push.example/v1/installations"):
          let body = try Self.body(request)
          XCTAssertEqual(body["endpoint"] as? String, Self.endpoint)
          XCTAssertEqual(body["endpoint_epoch"] as? Int, 1)
          XCTAssertEqual(body["expires_at"] as? Int64, Self.expiresAt)
          XCTAssertEqual(body["challenge_id"] as? String, Self.firstChallengeId)
          XCTAssertEqual(body["challenge"] as? String, Self.challenge)
          XCTAssertEqual(body["key_id"] as? String, Self.keyId)
          XCTAssertEqual(body["attestation"] as? String, Self.attestation)
          XCTAssertEqual(body["app_profile"] as? String, "buzz-ios-sandbox")
          return Self.response(
            request,
            status: 201,
            json: [
              "installation_handle": Self.installationHandle,
              "endpoint_epoch": 1,
              "expires_at": Self.expiresAt,
            ]
          )
        case ("POST", "http://push.example/v1/delegations"):
          let body = try Self.body(request)
          XCTAssertEqual(body["relay_pubkey"] as? String, Self.relayPubkey)
          XCTAssertEqual(body["installation_handle"] as? String, Self.installationHandle)
          XCTAssertEqual(body["challenge_id"] as? String, Self.secondChallengeId)
          XCTAssertEqual(body["challenge"] as? String, Self.challenge)
          XCTAssertEqual(body["endpoint_epoch"] as? Int, 1)
          XCTAssertEqual(body["not_before"] as? Int64, Self.now)
          XCTAssertEqual(body["expires_at"] as? Int64, Self.expiresAt)
          XCTAssertEqual(body["assertion"] as? String, Self.assertion)
          XCTAssertEqual(body["generation"] as? Int, 1)
          return Self.response(
            request,
            status: 201,
            json: ["endpoint_grant": "opaque-grant"]
          )
        default:
          XCTFail(
            "Unexpected request \(request.httpMethod ?? "nil") \(request.url?.absoluteString ?? "nil")"
          )
          return Self.response(request, status: 500, json: [:])
        }
      }

      let record = try await driver.enroll(
        deviceToken: Data((1...32).map(UInt8.init)),
        relayURL: Self.relayURL
      )

      XCTAssertEqual(appAttest.clientData.count, 2)
      try assertMatchesVector(
        "enroll",
        actual: appAttest.clientData[0],
        expectedSHA256: "362f5fc4c1fe7418dc879d9950223a273b2e915e4e37b008e66a1ab6b2fb1548",
        fixture: makeFixtureTranscript(
          name: "enroll",
          replacements: [
            ("buzz-ios-production", "buzz-ios-sandbox")
          ]
        )
      )
      try assertMatchesVector(
        "delegate",
        actual: appAttest.clientData[1],
        expectedSHA256: "f186db11cb53e4e80f09489c11dd18afc9b641683c3d72a67113c57d32fca323",
        fixture: makeFixtureTranscript(
          name: "delegate",
          replacements: [
            (Self.firstChallengeId, Self.secondChallengeId)
          ]
        )
      )
      XCTAssertEqual(
        record,
        BuzzPushEndpointGrantRecord(
          relayOrigin: "wss://relay.example/",
          relayPubkey: Self.relayPubkey,
          endpointGrant: "opaque-grant",
          endpointHash: Self.hex(SHA256.hash(data: Data((1...32).map(UInt8.init)))),
          appProfile: "buzz-ios-sandbox",
          endpointEpoch: 1,
          generation: 1,
          expiresAt: Self.expiresAt
        )
      )
      XCTAssertEqual(store.saved, [record])
    }

    func testDevelopmentAttestationMatchesGatewayBypassShape() throws {
      let entropy = Data(repeating: 0xAB, count: 32)
      let provider = BuzzDevAppAttestProvider(randomBytes: { entropy })
      let prepared = try provider.prepareAttestation()
      let bytes = try XCTUnwrap(Data(base64Encoded: prepared.attestation))
      XCTAssertEqual(
        bytes,
        Data("buzz-dev-app-attest-v1:".utf8) + entropy
      )
      XCTAssertEqual(
        prepared.keyId,
        Data(SHA256.hash(data: bytes)).base64EncodedString()
      )
      XCTAssertEqual(
        try provider.assertion(clientData: Data("transcript".utf8)),
        Self.assertion
      )
    }

    func testReusesPersistedUnexpiredGrant() async throws {
      let existing = BuzzPushEndpointGrantRecord(
        relayOrigin: "wss://relay.example/",
        relayPubkey: Self.relayPubkey,
        endpointGrant: "existing-grant",
        endpointHash: Self.hex(SHA256.hash(data: Data((1...32).map(UInt8.init)))),
        appProfile: "buzz-ios-sandbox",
        endpointEpoch: 1,
        generation: 1,
        expiresAt: Self.expiresAt
      )
      let store = MemoryGrantStore(records: [existing])
      let driver = try makeDriver(store: store, appAttest: RecordingAppAttest())
      URLProtocolStub.handler = { request in
        guard request.httpMethod == "GET" else {
          XCTFail("Persisted grant reuse must not call the gateway")
          return Self.response(request, status: 500, json: [:])
        }
        return Self.response(
          request,
          status: 200,
          json: ["push": ["keys": [["pubkey": Self.relayPubkey, "current": true]]]]
        )
      }

      let record = try await driver.enroll(
        deviceToken: Data((1...32).map(UInt8.init)),
        relayURL: Self.relayURL
      )

      XCTAssertEqual(record, existing)
      XCTAssertEqual(store.saved, [existing])
      XCTAssertEqual(URLProtocolStub.requests.count, 1)
    }

    func testRejectsMultipleCurrentRelayKeysBeforeGatewayEnrollment() async throws {
      let driver = try makeDriver(store: MemoryGrantStore(), appAttest: RecordingAppAttest())
      URLProtocolStub.handler = { request in
        Self.response(
          request,
          status: 200,
          json: [
            "push": [
              "keys": [
                ["pubkey": Self.relayPubkey, "current": true],
                ["pubkey": String(repeating: "b", count: 64), "current": true],
              ]
            ]
          ]
        )
      }

      do {
        _ = try await driver.enroll(deviceToken: Data([1]), relayURL: Self.relayURL)
        XCTFail("Expected an invalid relay descriptor")
      } catch {
        XCTAssertEqual(error as? BuzzDevPushEnrollmentError, .invalidRelayDescriptor)
      }
      XCTAssertEqual(URLProtocolStub.requests.count, 1)
    }

    func testFailsLoudlyOnUnexpectedGatewayStatus() async throws {
      let driver = try makeDriver(store: MemoryGrantStore(), appAttest: RecordingAppAttest())
      URLProtocolStub.handler = { request in
        if request.httpMethod == "GET" {
          return Self.response(
            request,
            status: 200,
            json: ["push": ["keys": [["pubkey": Self.relayPubkey, "current": true]]]]
          )
        }
        return Self.response(request, status: 400, json: ["error": "invalid_request"])
      }

      do {
        _ = try await driver.enroll(deviceToken: Data([1]), relayURL: Self.relayURL)
        XCTFail("Expected the gateway error")
      } catch let error as BuzzDevPushEnrollmentError {
        XCTAssertEqual(
          error,
          .unexpectedStatus(
            route: "v1/installations/challenges",
            expected: 200,
            actual: 400,
            body: "{\"error\":\"invalid_request\"}"
          )
        )
      }
    }

    private func makeDriver(
      store: BuzzPushEndpointGrantStore,
      appAttest: BuzzDevAppAttesting
    ) throws -> BuzzDevPushEnrollmentDriver {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [URLProtocolStub.self]
      return try BuzzDevPushEnrollmentDriver(
        gatewayBaseURL: Self.gatewayURL,
        store: store,
        session: URLSession(configuration: configuration),
        appAttest: appAttest,
        now: { Date(timeIntervalSince1970: TimeInterval(Self.now)) },
        lifetimeSeconds: Self.expiresAt - Self.now
      )
    }

    private func makeFixtureTranscript(
      name: String,
      replacements: [(String, String)]
    ) throws -> (bytes: Data, sha256: String) {
      let fixture = try Self.fixture()
      let vector = try XCTUnwrap(fixture.vectors.first { $0.name == name })
      let transcript = replacements.reduce(vector.transcript) {
        $0.replacingOccurrences(of: $1.0, with: $1.1)
      }
      return (Data(transcript.utf8), Self.hex(SHA256.hash(data: Data(transcript.utf8))))
    }

    private func assertMatchesVector(
      _ name: String,
      actual: Data,
      expectedSHA256: String,
      fixture: (bytes: Data, sha256: String),
      file: StaticString = #filePath,
      line: UInt = #line
    ) throws {
      XCTAssertEqual(
        fixture.sha256,
        expectedSHA256,
        "\(name) substituted gateway vector SHA-256",
        file: file,
        line: line
      )
      XCTAssertEqual(
        actual, fixture.bytes, "\(name) exact transcript bytes", file: file, line: line)
      XCTAssertEqual(
        Self.hex(SHA256.hash(data: actual)),
        fixture.sha256,
        "\(name) transcript SHA-256",
        file: file,
        line: line
      )
    }

    private struct Fixture: Decodable {
      struct Vector: Decodable {
        let name: String
        let transcript: String
      }
      let vectors: [Vector]
    }

    private static func fixture() throws -> Fixture {
      let here = URL(fileURLWithPath: #filePath)
      let repoRoot = (0..<6).reduce(here) { value, _ in value.deletingLastPathComponent() }
      let data = try Data(
        contentsOf: repoRoot.appendingPathComponent(
          "crates/buzz-push-gateway/tests/vectors/app_attest_transcripts.json"
        )
      )
      return try JSONDecoder().decode(Fixture.self, from: data)
    }

    private static func body(_ request: URLRequest) throws -> [String: Any] {
      let data: Data
      if let httpBody = request.httpBody {
        data = httpBody
      } else {
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while true {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count < 0 {
            throw try XCTUnwrap(stream.streamError)
          }
          if count == 0 { break }
          bytes.append(buffer, count: count)
        }
        data = bytes
      }
      return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func response(
      _ request: URLRequest,
      status: Int,
      json: [String: Any]
    ) -> (HTTPURLResponse, Data) {
      let data = try! JSONSerialization.data(withJSONObject: json, options: [.sortedKeys])
      let response = HTTPURLResponse(
        url: request.url!,
        statusCode: status,
        httpVersion: "HTTP/1.1",
        headerFields: ["Content-Type": "application/json"]
      )!
      return (response, data)
    }

    private static func hex<D: Sequence>(_ data: D) -> String where D.Element == UInt8 {
      data.map { String(format: "%02x", $0) }.joined()
    }
  }

  private final class MemoryGrantStore: BuzzPushEndpointGrantStore {
    var saved: [BuzzPushEndpointGrantRecord]
    init(records: [BuzzPushEndpointGrantRecord] = []) { saved = records }
    func records() throws -> [BuzzPushEndpointGrantRecord] { saved }
    func save(_ record: BuzzPushEndpointGrantRecord) throws { saved = [record] }
  }

  private final class RecordingAppAttest: BuzzDevAppAttesting {
    var clientData: [Data] = []

    func prepareAttestation() throws -> BuzzDevAttestation {
      BuzzDevAttestation(
        keyId: BuzzDevPushEnrollmentDriverTests.keyId,
        attestation: BuzzDevPushEnrollmentDriverTests.attestation
      )
    }

    func attestation(
      _ prepared: BuzzDevAttestation,
      clientData: Data
    ) throws -> BuzzDevAttestation {
      self.clientData.append(clientData)
      return prepared
    }

    func assertion(clientData: Data) throws -> String {
      self.clientData.append(clientData)
      return BuzzDevPushEnrollmentDriverTests.assertion
    }
  }

  private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
      Self.lock.lock()
      Self.requests.append(request)
      let handler = Self.handler
      Self.lock.unlock()
      do {
        let (response, data) =
          try handler?(request)
          ?? {
            throw URLError(.unsupportedURL)
          }()
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
      } catch {
        client?.urlProtocol(self, didFailWithError: error)
      }
    }

    override func stopLoading() {}

    static func reset() {
      lock.lock()
      handler = nil
      requests = []
      lock.unlock()
    }
  }
#endif
