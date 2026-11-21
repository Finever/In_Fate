using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;

internal static class Program
{
    // Footer: [16-byte magic][8-byte little-endian payload length].
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("IN_FATE_SETUP_V1");
    private const int FooterSize = 8;

    private static int Main(string[] args)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        string work = Path.Combine(Path.GetTempPath(), "In_Fate-Setup-" + Guid.NewGuid().ToString("N"));
        string zip = work + ".zip";

        try
        {
            if (HasArg(args, "--portable"))
            {
                throw new InvalidOperationException("--portable is not supported by the setup exe; use the release zip instead");
            }
            if ((HasArg(args, "--uninstall") || HasArg(args, "--repair")) && !HasArg(args, "--dir"))
            {
                throw new InvalidOperationException("--uninstall/--repair need an explicit --dir when using the setup exe; prefer the installed uninstall.cmd/repair.cmd");
            }

            Console.WriteLine("In_Fate Setup");
            Console.WriteLine("Extracting package...");
            ExtractPayload(self, zip);
            Directory.CreateDirectory(work);
            ExtractZip(zip, work);

            string root = Path.Combine(work, "In_First");
            string installCmd = Path.Combine(root, "install.cmd");
            if (!File.Exists(installCmd))
            {
                throw new FileNotFoundException("install.cmd was not found in the package", installCmd);
            }

            var forwarded = new StringBuilder();
            forwarded.Append("--launch");
            foreach (string arg in args)
            {
                forwarded.Append(' ');
                forwarded.Append(Quote(arg));
            }

            var start = new ProcessStartInfo();
            start.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            start.Arguments = "/d /c call \"" + installCmd + "\" " + forwarded;
            start.WorkingDirectory = root;
            start.UseShellExecute = false;

            Console.WriteLine("Starting installer...");
            using (Process process = Process.Start(start))
            {
                if (process == null)
                {
                    throw new InvalidOperationException("could not start install.cmd");
                }
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Setup failed: " + error.Message);
            if (!Console.IsInputRedirected)
            {
                Console.Error.WriteLine("Press any key to close...");
                try { Console.ReadKey(true); } catch { }
            }
            return 1;
        }
        finally
        {
            TryDeleteFile(zip);
            TryDeleteDirectory(work);
        }
    }

    private static void ExtractPayload(string exePath, string zipPath)
    {
        using (var input = new FileStream(exePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            int minimum = Magic.Length + FooterSize;
            if (input.Length < minimum)
            {
                throw new InvalidDataException("installer payload is missing");
            }

            var footer = new byte[minimum];
            input.Seek(-minimum, SeekOrigin.End);
            ReadExactly(input, footer, footer.Length);

            for (int i = 0; i < Magic.Length; i++)
            {
                if (footer[i] != Magic[i])
                {
                    throw new InvalidDataException("installer payload magic does not match");
                }
            }

            long payloadSize = BitConverter.ToInt64(footer, Magic.Length);
            if (payloadSize <= 0 || payloadSize > input.Length - minimum)
            {
                throw new InvalidDataException("installer payload size is invalid");
            }

            input.Seek(-(minimum + payloadSize), SeekOrigin.End);
            using (var output = new FileStream(zipPath, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                CopyBytes(input, output, payloadSize);
            }
        }
    }

    private static void ExtractZip(string zipPath, string destination)
    {
        string root = Path.GetFullPath(destination);
        string rootWithSeparator = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;

        using (ZipArchive archive = ZipFile.OpenRead(zipPath))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                if (!target.StartsWith(rootWithSeparator, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("zip entry escapes the extraction directory: " + entry.FullName);
                }

                if (entry.Name == "")
                {
                    Directory.CreateDirectory(target);
                    continue;
                }

                string parent = Path.GetDirectoryName(target);
                if (!String.IsNullOrEmpty(parent))
                {
                    Directory.CreateDirectory(parent);
                }
                entry.ExtractToFile(target, true);
            }
        }
    }

    private static void CopyBytes(Stream input, Stream output, long count)
    {
        var buffer = new byte[1024 * 1024];
        long left = count;
        while (left > 0)
        {
            int read = input.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
            if (read <= 0)
            {
                throw new EndOfStreamException("installer payload is truncated");
            }
            output.Write(buffer, 0, read);
            left -= read;
        }
    }

    private static void ReadExactly(Stream input, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = input.Read(buffer, offset, count - offset);
            if (read <= 0)
            {
                throw new EndOfStreamException("installer footer is truncated");
            }
            offset += read;
        }
    }

    private static bool HasArg(string[] args, string name)
    {
        foreach (string arg in args)
        {
            if (String.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string Quote(string value)
    {
        if (value.Length == 0) return "\"\"";
        if (value.IndexOfAny(new[] { ' ', '\t', '\"', '&', '|', '<', '>', '^' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, true);
        }
        catch
        {
        }
    }
}
