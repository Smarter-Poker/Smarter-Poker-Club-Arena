// macOS operator helper. The permanent private key never leaves login Keychain.
// Compile this at its durable owner path before provisioning the recipient.
import Foundation
import Security
import CryptoKit
import LocalAuthentication
import Darwin

let applicationTag = Data("poker.smarter.horse-human-results.01a1789f.recipient.v1".utf8)
enum Refusal: Error { case refused(String, Int) }

func privateRecipient(create: Bool) throws -> SecKey {
    let authentication = LAContext()
    authentication.interactionNotAllowed = true
    let query: [String: Any] = [kSecClass as String: kSecClassKey,
        kSecAttrApplicationTag as String: applicationTag,
        kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
        kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
        kSecReturnRef as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        kSecUseAuthenticationContext as String: authentication]
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecSuccess, let found { return found as! SecKey }
    guard status == errSecItemNotFound && create else {
        throw Refusal.refused("keychain_lookup", Int(status))
    }
    let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
        kSecAttrKeySizeInBits as String: 4096,
        kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true,
            kSecAttrIsExtractable as String: false,
            kSecAttrCanSign as String: false, kSecAttrCanDerive as String: false,
            kSecAttrCanDecrypt as String: true,
            kSecAttrApplicationTag as String: applicationTag,
            kSecAttrLabel as String: "Smarter Poker private human-result report recipient"]]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
        throw Refusal.refused("keychain_create", error.map { CFErrorGetCode($0.takeRetainedValue()) } ?? 0)
    }
    return key
}

func der(_ tag: UInt8, _ bytes: Data) -> Data {
    var length = bytes.count, encoded = [UInt8]()
    if length < 128 { encoded = [UInt8(length)] }
    else {
        while length > 0 { encoded.insert(UInt8(length & 255), at: 0); length >>= 8 }
        encoded.insert(0x80 | UInt8(encoded.count), at: 0)
    }
    return Data([tag]) + Data(encoded) + bytes
}

func publicSPKI(_ privateKey: SecKey) throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else { throw Refusal.refused("public_key", 0) }
    var error: Unmanaged<CFError>?
    // Only the PUBLIC key is exported. RSA's public representation is PKCS#1;
    // wrap its rsaEncryption AlgorithmIdentifier and BIT STRING as SPKI.
    guard let exported = SecKeyCopyExternalRepresentation(publicKey, &error) else {
        throw Refusal.refused("public_export", error.map { CFErrorGetCode($0.takeRetainedValue()) } ?? 0)
    }
    let algorithm = Data([0x30,0x0d,0x06,0x09,0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01,0x05,0x00])
    return der(0x30, algorithm + der(0x03, Data([0]) + (exported as Data)))
}

func fingerprint(_ key: SecKey) throws -> String {
    SHA256.hash(data: try publicSPKI(key)).map { String(format: "%02x", $0) }.joined()
}

func decrypt(_ key: SecKey, input: String, output: String) throws {
    let size = try FileManager.default.attributesOfItem(atPath: input)[.size] as? NSNumber
    guard let size, size.intValue <= 12 * 1024 * 1024,
          let envelope = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: input))) as? [String: Any],
          envelope["version"] as? Int == 1, envelope["kind"] as? String == "horse-human-results",
          envelope["algorithm"] as? String == "RSA-OAEP-SHA256+AES-256-GCM",
          let revision = envelope["source_revision"] as? String,
          revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
          let recipient = envelope["recipient_sha256"] as? String,
          recipient == (try fingerprint(key)) else { throw Refusal.refused("envelope_identity", 0) }
    func bytes(_ name: String, limit: Int, exact: Int? = nil) throws -> Data {
        guard let text = envelope[name] as? String, text.count <= ((limit + 2) / 3) * 4,
              let data = Data(base64Encoded: text), !data.isEmpty, data.count <= limit,
              data.base64EncodedString() == text,
              exact == nil || data.count == exact else { throw Refusal.refused("envelope_field", 0) }
        return data
    }
    guard SecKeyIsAlgorithmSupported(key, .decrypt, .rsaEncryptionOAEPSHA256) else {
        throw Refusal.refused("key_algorithm", 0)
    }
    var error: Unmanaged<CFError>?
    guard let unwrapped = SecKeyCreateDecryptedData(key, .rsaEncryptionOAEPSHA256,
        try bytes("wrapped_key", limit: 1024) as CFData, &error) else {
        throw Refusal.refused("keychain_decrypt", error.map { CFErrorGetCode($0.takeRetainedValue()) } ?? 0)
    }
    let symmetric = unwrapped as Data
    guard symmetric.count == 32 else { throw Refusal.refused("content_key", 0) }
    let identity = "{\"version\":1,\"kind\":\"horse-human-results\",\"source_revision\":\"\(revision)\",\"recipient_sha256\":\"\(recipient)\"}"
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: try bytes("nonce", limit: 12, exact: 12)),
        ciphertext: try bytes("ciphertext", limit: 8 * 1024 * 1024),
        tag: try bytes("tag", limit: 16, exact: 16))
    let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: symmetric), authenticating: Data(identity.utf8))
    guard let report = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
          report["status"] as? String == "observed", report["source_revision"] as? String == revision else {
        throw Refusal.refused("report_identity", 0)
    }
    let descriptor = open(output, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw Refusal.refused("private_output", Int(errno)) }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    try handle.write(contentsOf: plaintext)
    try handle.close()
    print("Verified authenticated report written with owner-only permissions.")
}

umask(0o077)
do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["provision"] || arguments == ["public"] {
        let key = try privateRecipient(create: arguments[0] == "provision")
        let text = try publicSPKI(key).base64EncodedString()
        print("-----BEGIN PUBLIC KEY-----")
        for start in stride(from: 0, to: text.count, by: 64) {
            let a = text.index(text.startIndex, offsetBy: start)
            let b = text.index(a, offsetBy: min(64, text.count - start))
            print(text[a..<b])
        }
        print("-----END PUBLIC KEY-----")
    } else if arguments.count == 3 && arguments[0] == "decrypt" {
        try decrypt(privateRecipient(create: false), input: arguments[1], output: arguments[2])
    } else { throw Refusal.refused("usage_provision_public_or_decrypt", 64) }
} catch Refusal.refused(let operation, let code) {
    FileHandle.standardError.write(Data("Report keychain operation refused: \(operation) (\(code)).\n".utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("Report envelope verification refused. No plaintext output was published.\n".utf8))
    exit(1)
}
