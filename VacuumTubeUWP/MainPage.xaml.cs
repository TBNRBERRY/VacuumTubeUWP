using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using Windows.Storage;
using Windows.UI.Xaml.Controls;

namespace VacuumTubeUWP
{
    // Simplified Context for JSON Source Generation
    [JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
    [JsonSerializable(typeof(JsonElement))]
    internal partial class BridgeContext : JsonSerializerContext { }

    public sealed partial class MainPage : Page
    {
        private readonly StorageFolder _localFolder = ApplicationData.Current.LocalFolder;
        private readonly string _configFileName = "config.json";
        private readonly string _defaultConfigJson = "{\"adblock\": true, \"sponsorblock\": true, \"dislikes\": true, \"controller_support\": true}";

        public MainPage()
        {
            this.InitializeComponent();
            _ = InitializeWebView();
        }

        private async Task InitializeWebView()
        {
            try
            {
                await WebView.EnsureCoreWebView2Async();
                WebView.CoreWebView2.Settings.IsZoomControlEnabled = false; // Prevent accidental pinch-zoom on Xbox
                WebView.CoreWebView2.Settings.IsGeneralAutofillEnabled = false; // Keep the UI clean

                // 1. Setup DevTools and Mappings
                WebView.CoreWebView2.OpenDevToolsWindow();
                WebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "pixeltube.local", "src", CoreWebView2HostResourceAccessKind.Allow);

                // 2. Setup Events
                WebView.CoreWebView2.WebResourceRequested += CoreWebView2_WebResourceRequested;
                WebView.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                WebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                WebView.CoreWebView2.NavigationStarting += OnNavigationStarting;

                // 3. Inject the MASTER BUNDLE
                // Note: Path is now 'src' as per your new directory tree
                StorageFile bundleFile = await StorageFile.GetFileFromApplicationUriAsync(new Uri("ms-appx:///src/main-bundle.js"));
                string bundleScript = await FileIO.ReadTextAsync(bundleFile);

                // This ensures everything is ready before the page loads
                await WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(bundleScript);

                // 4. Set UA and Navigate
                WebView.CoreWebView2.Settings.UserAgent = "Mozilla/5.0 (Web0S; SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.202 Safari/537.36 SmartTV";
                WebView.Source = new Uri("https://www.youtube.com/tv");
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[PixelTube] Init Error: {ex.Message}");
            }
        }

        private async void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs args)
        {
            // Push config to the JS 'config' module on every load
            string configJson = await GetConfigContent();
            string message = $"{{\"type\": \"config-update\", \"config\": {configJson}}}";
            sender.PostWebMessageAsJson(message);
        }

        private void CoreWebView2_WebResourceRequested(CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
        {
            string uri = args.Request.Uri.ToLower();
            // Broaden the filter to catch more ad-related requests
            if (uri.Contains("doubleclick.net") ||
                uri.Contains("googleads") ||
                uri.Contains("/pagead/") ||
                uri.Contains("pubads") ||
                uri.Contains("ad_status.js") || // Specifically blocking the one in your log
                uri.Contains("youtubei/v1/player/ad_break"))
            {
                args.Response = sender.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
            }
        }

        private async void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            try
            {
                using JsonDocument doc = JsonDocument.Parse(args.WebMessageAsJson);
                JsonElement root = doc.RootElement;
                string type = root.TryGetProperty("type", out JsonElement t) ? t.GetString() ?? "" : "";

                // --- EXISTING CONFIG HANDLER ---
                if (type == "set-config")
                {
                    if (root.TryGetProperty("config", out JsonElement configElement))
                    {
                        await SaveConfig(configElement.GetRawText());
                    }
                }

                // --- NEW: IPC_INVOKE HANDLER (For Settings & Controls) ---
                else if (type == "IPC_INVOKE")
                {
                    string channel = root.TryGetProperty("channel", out JsonElement c) ? c.GetString() ?? "" : "";
                    var value = root.TryGetProperty("value", out JsonElement v) ? v : default;

                    switch (channel)
                    {
                        case "set-fullscreen":
                            // Xbox apps are usually fullscreen, but this handles the toggle
                            bool isFullscreen = value.ValueKind == JsonValueKind.True;
                            System.Diagnostics.Debug.WriteLine($"[PixelTube] Fullscreen toggled: {isFullscreen}");
                            break;

                        case "get-userstyles":
                            // We send an empty array back to JS to prevent the "File Not Found" crash
                            sender.PostWebMessageAsJson("{\"type\": \"userstyles-list\", \"styles\": []}");
                            break;

                        case "close-app":
                            Windows.UI.Xaml.Application.Current.Exit();
                            break;
                    }
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"[PixelTube] Bridge Error: {ex.Message}");
            }
        }

        private async Task<string> GetConfigContent()
        {
            try
            {
                StorageFile configFile = await _localFolder.GetFileAsync(_configFileName);
                return await FileIO.ReadTextAsync(configFile);
            }
            catch (FileNotFoundException)
            {
                return _defaultConfigJson;
            }
        }

        private async Task SaveConfig(string jsonConfig)
        {
            StorageFile configFile = await _localFolder.CreateFileAsync(_configFileName, CreationCollisionOption.ReplaceExisting);
            await FileIO.WriteTextAsync(configFile, jsonConfig);
        }
    }
}