const axios = require('axios');

async function testCardBuilderApiUrlEncoded() {
    const params = new URLSearchParams();
    params.append('search', 'black lotus');
    params.append('order', 'recent');
    params.append('nsfw', '0');
    params.append('other', '0');
    params.append('cpage', '1');
    params.append('action', 'builder_ajax');
    params.append('method', 'search_gallery_cards');

    try {
        const response = await axios.post('https://mtgcardbuilder.com/wp-admin/admin-ajax.php', params, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0',
                'Origin': 'https://mtgcardbuilder.com',
                'Referer': 'https://mtgcardbuilder.com/mtg-custom-card-gallery/',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log("Status:", response.status);
        console.log("Data type:", typeof response.data);
         if (typeof response.data === 'string') {
             console.log("Data (first 100 chars):", response.data.substring(0, 100));
        } else {
             // console.log("Data:", JSON.stringify(response.data, null, 2));
             console.log("Success! Got JSON data.");
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

testCardBuilderApiUrlEncoded();

