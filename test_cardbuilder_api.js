const axios = require('axios');
const FormData = require('form-data');

async function testCardBuilderApi() {
    const formData = new FormData();
    formData.append('search', 'black lotus');
    formData.append('order', 'recent');
    formData.append('nsfw', '0');
    formData.append('other', '0');
    formData.append('cpage', '1');
    formData.append('action', 'builder_ajax');
    formData.append('method', 'search_gallery_cards');

    try {
        const response = await axios.post('https://mtgcardbuilder.com/wp-admin/admin-ajax.php', formData, {
            headers: {
                ...formData.getHeaders(),
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0',
                'Origin': 'https://mtgcardbuilder.com',
                'Referer': 'https://mtgcardbuilder.com/mtg-custom-card-gallery/'
            }
        });

        console.log("Status:", response.status);
        // console.log("Data:", JSON.stringify(response.data, null, 2));
        console.log("Data type:", typeof response.data);
        if (typeof response.data === 'string') {
             console.log("Data (first 500 chars):", response.data.substring(0, 500));
        } else {
             console.log("Data:", JSON.stringify(response.data, null, 2));
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

testCardBuilderApi();

